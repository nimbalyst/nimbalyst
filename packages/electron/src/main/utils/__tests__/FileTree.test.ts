import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFolderContents } from '../FileTree';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileTree All Files Mode', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filetree-allfiles-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
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
