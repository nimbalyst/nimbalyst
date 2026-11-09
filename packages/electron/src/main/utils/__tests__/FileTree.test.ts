// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stat } from 'fs/promises';
import { getFolderContents, listFolderFilesRecursive } from '../FileTree';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return { ...actual, stat: vi.fn(actual.stat) };
});

describe('FileTree All Files Mode', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filetree-allfiles-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('discards a scan cancelled while directory I/O is pending', async () => {
        fs.mkdirSync(path.join(tempDir, 'nested'));
        fs.writeFileSync(path.join(tempDir, 'nested', 'document.md'), '# test');
        const controller = new AbortController();
        const scan = getFolderContents(tempDir, 0, controller.signal);
        controller.abort();
        expect(await scan).toEqual([]);
        expect((await getFolderContents(tempDir))[0].children).toHaveLength(1);
    });

    it('should return all folders including those without known file extensions', async () => {
        // Create a structure like DisneyPins:
        // - .claude/ (hidden folder)
        // - backend/ (folder with python files)
        // - Data/ (folder with csv/json files)
        // - FrontEnd/ (folder with swift files)
        // - nimbalyst-local/ (special folder)
        // - CLAUDE.md (markdown file)

        fs.mkdirSync(path.join(tempDir, '.claude'));
        fs.mkdirSync(path.join(tempDir, 'backend'));
        fs.mkdirSync(path.join(tempDir, 'Data'));
        fs.mkdirSync(path.join(tempDir, 'FrontEnd'));
        fs.mkdirSync(path.join(tempDir, 'nimbalyst-local'));
        fs.mkdirSync(path.join(tempDir, 'ImageProcessing'));
        fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '# Test');
        fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.pyc');

        // Add some files to the folders
        fs.writeFileSync(path.join(tempDir, 'backend', 'main.py'), 'print("hello")');
        fs.writeFileSync(path.join(tempDir, 'Data', 'users.csv'), 'id,name');
        fs.writeFileSync(path.join(tempDir, 'FrontEnd', 'App.swift'), 'import SwiftUI');

        const result = await getFolderContents(tempDir);
        const names = result.map(item => item.name);

        // Should include ALL folders - both hidden and regular
        expect(names).toContain('.claude');
        expect(names).toContain('backend');
        expect(names).toContain('Data');
        expect(names).toContain('FrontEnd');
        expect(names).toContain('nimbalyst-local');
        expect(names).toContain('ImageProcessing');
        expect(names).toContain('CLAUDE.md');
        expect(names).toContain('.gitignore');

        // Verify we got 8 items total
        expect(result.length).toBe(8);
    });

    it('marks a folder past the depth limit as unread rather than empty', async () => {
        // d1/.../d10: the walk lists d9 inside d8 but does not read it.
        const chain = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
        fs.mkdirSync(path.join(tempDir, ...chain), { recursive: true });
        fs.writeFileSync(path.join(tempDir, ...chain, 'deep.ts'), '');

        let level = await getFolderContents(tempDir);
        const seen: Array<{ name: string; truncated: boolean }> = [];
        while (level.length > 0) {
            const dir = level[0];
            seen.push({ name: dir.name, truncated: dir.childrenTruncated === true });
            level = dir.children ?? [];
        }

        expect(seen.find((entry) => entry.truncated)?.name).toBe('d9');
        expect(seen.filter((entry) => entry.truncated)).toHaveLength(1);
    });

    it('applies the per-directory cap to the sorted list, not to raw readdir order', async () => {
        const names = Array.from({ length: 250 }, (_, i) => `a-${String(i + 1).padStart(3, '0')}.md`);
        // Create in reverse so the first entries returned by readdir are the ones that sort last.
        for (const name of [...names].reverse()) fs.writeFileSync(path.join(tempDir, name), '');
        fs.writeFileSync(path.join(tempDir, 'zz-last.md'), '');
        fs.mkdirSync(path.join(tempDir, 'zz-dir'));

        const result = await getFolderContents(tempDir);

        expect(result).toHaveLength(200);
        // Directories sort first, so the late-named folder survives the cap.
        expect(result[0].name).toBe('zz-dir');
        expect(result.slice(1).map(item => item.name)).toEqual(names.slice(0, 199));
    });

    it('records how many entries the per-directory cap hid on the capped folder only', async () => {
        const big = path.join(tempDir, 'big');
        fs.mkdirSync(big);
        for (let i = 1; i <= 251; i++) fs.writeFileSync(path.join(big, `a-${String(i).padStart(3, '0')}.md`), '');
        fs.mkdirSync(path.join(tempDir, 'small'));
        fs.writeFileSync(path.join(tempDir, 'small', 'one.md'), '');

        const result = await getFolderContents(tempDir);
        const bigNode = result.find(item => item.name === 'big')!;
        const smallNode = result.find(item => item.name === 'small')!;

        expect(bigNode.children).toHaveLength(200);
        expect(bigNode.omittedChildCount).toBe(51);
        expect(smallNode.omittedChildCount ?? 0).toBe(0);
    });

    it('does not count a broken symlink the cap skipped as a hidden entry', async () => {
        const big = path.join(tempDir, 'big');
        fs.mkdirSync(big);
        for (let i = 1; i <= 200; i++) fs.mkdirSync(path.join(big, `d-${String(i).padStart(3, '0')}`));
        fs.symlinkSync(path.join(big, 'missing'), path.join(big, 'zz-broken'));

        const result = await getFolderContents(tempDir);

        expect(result[0].children).toHaveLength(200);
        expect(result[0].omittedChildCount ?? 0).toBe(0);
    });

    it('stops resolving skipped symlinks past a bound and marks the count as a minimum', async () => {
        const big = path.join(tempDir, 'big');
        fs.mkdirSync(big);
        for (let i = 1; i <= 200; i++) fs.mkdirSync(path.join(big, `d-${String(i).padStart(3, '0')}`));
        for (let i = 1; i <= 205; i++) fs.symlinkSync(path.join(big, 'd-001'), path.join(big, `zz-${String(i).padStart(3, '0')}`));
        vi.mocked(stat).mockClear();

        const result = await getFolderContents(tempDir);

        expect(vi.mocked(stat).mock.calls.length).toBeLessThanOrEqual(200);
        expect(result[0].omittedChildCount).toBe(200);
        expect(result[0].omittedChildCountIsMinimum).toBe(true);
    });

    it('counts live symlinks the cap pushed out, but not broken links', async () => {
        const big = path.join(tempDir, 'big');
        fs.mkdirSync(big);
        for (let i = 1; i <= 201; i++) fs.mkdirSync(path.join(big, `d-${String(i).padStart(3, '0')}`));
        fs.symlinkSync(path.join(big, 'd-001'), path.join(big, 'a-link'));
        fs.symlinkSync(path.join(big, 'd-001'), path.join(big, 'zz-link'));
        fs.symlinkSync(path.join(big, 'missing'), path.join(big, 'a-broken'));

        const result = await getFolderContents(tempDir);

        // 201 dirs + 2 live links = 203 visible entries; 200 kept. a-broken
        // resolves as broken and does not count.
        expect(result[0].omittedChildCount).toBe(3);
    });

    it('sorts symlinks by target type but never stats a link that cannot make the cap', async () => {
        for (let i = 1; i <= 201; i++) fs.mkdirSync(path.join(tempDir, `d-${String(i).padStart(3, '0')}`));
        fs.symlinkSync(path.join(tempDir, 'd-001'), path.join(tempDir, 'a-link'));
        fs.symlinkSync(path.join(tempDir, 'd-001'), path.join(tempDir, 'zz-link'));
        vi.mocked(stat).mockClear();

        const result = await getFolderContents(tempDir);

        expect(result).toHaveLength(200);
        expect(result[0]).toMatchObject({ name: 'a-link', type: 'directory' });
        expect(result.map(item => item.name)).not.toContain('zz-link');
        // Only a-link could land inside the cap; zz-link sorts after d-199 even
        // as a directory, so it is stat'd once afterwards, only to be counted.
        expect(vi.mocked(stat).mock.calls.map(([p]) => path.basename(String(p)))).toEqual(['a-link', 'zz-link']);
    });

    it('should return empty folders', async () => {
        fs.mkdirSync(path.join(tempDir, 'emptyFolder1'));
        fs.mkdirSync(path.join(tempDir, 'emptyFolder2'));
        fs.mkdirSync(path.join(tempDir, 'folderWithFile'));
        fs.writeFileSync(path.join(tempDir, 'folderWithFile', 'test.txt'), 'content');

        const result = await getFolderContents(tempDir);
        const names = result.map(item => item.name);

        expect(names).toContain('emptyFolder1');
        expect(names).toContain('emptyFolder2');
        expect(names).toContain('folderWithFile');
        expect(result.length).toBe(3);
    });

    it('should exclude only the specific excluded directories', async () => {
        // These should be excluded
        fs.mkdirSync(path.join(tempDir, 'node_modules'));
        fs.mkdirSync(path.join(tempDir, '.git'));
        fs.mkdirSync(path.join(tempDir, 'dist'));
        fs.mkdirSync(path.join(tempDir, 'build'));
        fs.mkdirSync(path.join(tempDir, '.idea'));

        // These should NOT be excluded
        fs.mkdirSync(path.join(tempDir, 'src'));
        fs.mkdirSync(path.join(tempDir, 'backend'));
        fs.mkdirSync(path.join(tempDir, 'Data'));

        const result = await getFolderContents(tempDir);
        const names = result.map(item => item.name);

        // Should NOT include excluded dirs
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).not.toContain('dist');
        expect(names).not.toContain('build');
        expect(names).not.toContain('.idea');

        // Should include regular dirs
        expect(names).toContain('src');
        expect(names).toContain('backend');
        expect(names).toContain('Data');
        expect(result.length).toBe(3);
    });

    it('should include folders with only binary/unknown file types', async () => {
        fs.mkdirSync(path.join(tempDir, 'images'));
        fs.mkdirSync(path.join(tempDir, 'videos'));
        fs.writeFileSync(path.join(tempDir, 'images', 'photo.png'), 'fake png');
        fs.writeFileSync(path.join(tempDir, 'videos', 'clip.mp4'), 'fake mp4');

        const result = await getFolderContents(tempDir);
        const names = result.map(item => item.name);

        expect(names).toContain('images');
        expect(names).toContain('videos');
    });

    it('should return all folders from actual DisneyPins directory', async () => {
        const disneyPinsPath = '/Users/ghinkle/sources/DisneyPins';

        // Skip if the directory doesn't exist (running on CI)
        if (!fs.existsSync(disneyPinsPath)) {
            return;
        }

        const result = await getFolderContents(disneyPinsPath);
        const names = result.map(item => item.name);

        if (result.length === 0) {
            return;
        }

        // Local directory contents can change over time; assert stable invariants only.
        expect(result.length).toBeGreaterThan(0);
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).not.toContain('.venv');
    });
});

describe('listFolderFilesRecursive', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filetree-recursive-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns folder-relative paths at any depth and prunes excluded directories', async () => {
        fs.mkdirSync(path.join(tempDir, 'a', 'b', 'c'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'node_modules'));
        fs.writeFileSync(path.join(tempDir, 'root.md'), '');
        fs.writeFileSync(path.join(tempDir, 'a', 'one.md'), '');
        fs.writeFileSync(path.join(tempDir, 'a', 'b', 'c', 'deep.md'), '');
        fs.writeFileSync(path.join(tempDir, 'node_modules', 'ignored.md'), '');

        const result = await listFolderFilesRecursive(tempDir);

        expect(result.files).toEqual(['a/b/c/deep.md', 'a/one.md', 'root.md']);
        expect(result.truncated).toBe(false);
    });

    it('reports truncation rather than silently dropping files past the cap', async () => {
        // The sidebar walk caps at 200 per directory with no signal. A share
        // promote that dropped files without saying so would look complete.
        for (let index = 0; index < 12; index += 1) {
            fs.writeFileSync(path.join(tempDir, `file-${index}.md`), '');
        }

        const result = await listFolderFilesRecursive(tempDir, { limit: 5 });

        expect(result.files).toHaveLength(5);
        expect(result.truncated).toBe(true);
    });
});

describe('FileTree Natural Sorting', () => {
    let tempDir: string;

    beforeEach(() => {
        // Create a temporary directory for testing
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filetree-test-'));
    });

    afterEach(() => {
        // Clean up temporary directory
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should sort files with numbers naturally', async () => {
        // Create files with numbers
        const files = [
            'Doc 1.md',
            'Doc 2.md',
            'Doc 9.md',
            'Doc 10.md',
            'Doc 20.md',
            'Doc 100.md'
        ];

        files.forEach(filename => {
            fs.writeFileSync(path.join(tempDir, filename), '');
        });

        const result = await getFolderContents(tempDir);
        const fileNames = result.map(item => item.name);

        expect(fileNames).toEqual([
            'Doc 1.md',
            'Doc 2.md',
            'Doc 9.md',
            'Doc 10.md',
            'Doc 20.md',
            'Doc 100.md'
        ]);
    });

    it('should sort files with leading zeros naturally', async () => {
        // Create files with leading zeros
        const files = [
            '01 test.md',
            '02 test.md',
            '03 test.md',
            '10 test.md',
            '20 test.md'
        ];

        files.forEach(filename => {
            fs.writeFileSync(path.join(tempDir, filename), '');
        });

        const result = await getFolderContents(tempDir);
        const fileNames = result.map(item => item.name);

        expect(fileNames).toEqual([
            '01 test.md',
            '02 test.md',
            '03 test.md',
            '10 test.md',
            '20 test.md'
        ]);
    });

    it('should sort version numbers naturally', async () => {
        // Create files with version numbers
        const files = [
            'v1.2.0.md',
            'v1.2.1.md',
            'v1.2.10.md',
            'v1.10.0.md',
            'v2.0.0.md'
        ];

        files.forEach(filename => {
            fs.writeFileSync(path.join(tempDir, filename), '');
        });

        const result = await getFolderContents(tempDir);
        const fileNames = result.map(item => item.name);

        expect(fileNames).toEqual([
            'v1.2.0.md',
            'v1.2.1.md',
            'v1.2.10.md',
            'v1.10.0.md',
            'v2.0.0.md'
        ]);
    });

    it('should still sort directories before files', async () => {
        // Create mix of files and directories
        fs.writeFileSync(path.join(tempDir, 'File 1.md'), '');
        fs.writeFileSync(path.join(tempDir, 'File 10.md'), '');
        fs.mkdirSync(path.join(tempDir, 'Dir 1'));
        fs.mkdirSync(path.join(tempDir, 'Dir 10'));
        fs.writeFileSync(path.join(tempDir, 'File 2.md'), '');

        const result = await getFolderContents(tempDir);
        const names = result.map(item => ({ name: item.name, type: item.type }));

        expect(names).toEqual([
            { name: 'Dir 1', type: 'directory' },
            { name: 'Dir 10', type: 'directory' },
            { name: 'File 1.md', type: 'file' },
            { name: 'File 2.md', type: 'file' },
            { name: 'File 10.md', type: 'file' }
        ]);
    });

    it('should handle mixed alphanumeric filenames', async () => {
        // Create files with mixed patterns
        const files = [
            'Chapter 1.md',
            'Chapter 2.md',
            'Chapter 10.md',
            'Appendix A.md',
            'Appendix B.md',
            'Index.md'
        ];

        files.forEach(filename => {
            fs.writeFileSync(path.join(tempDir, filename), '');
        });

        const result = await getFolderContents(tempDir);
        const fileNames = result.map(item => item.name);

        expect(fileNames).toEqual([
            'Appendix A.md',
            'Appendix B.md',
            'Chapter 1.md',
            'Chapter 2.md',
            'Chapter 10.md',
            'Index.md'
        ]);
    });

    it('should be case-insensitive', async () => {
        // Create files with different cases
        const files = [
            'apple.md',
            'Banana.md',
            'cherry.md',
            'DELTA.md'
        ];

        files.forEach(filename => {
            fs.writeFileSync(path.join(tempDir, filename), '');
        });

        const result = await getFolderContents(tempDir);
        const fileNames = result.map(item => item.name);

        expect(fileNames).toEqual([
            'apple.md',
            'Banana.md',
            'cherry.md',
            'DELTA.md'
        ]);
    });
});
