// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveLaunchTarget, type PathKind } from '../launchTarget';

const tree: Record<string, PathKind> = {
    '/Users/me/project': 'directory',
    '/Users/me/project/src': 'directory',
    '/Users/me/project/README.md': 'file',
};
const kindOf = (p: string): PathKind => tree[p] ?? null;

describe('resolveLaunchTarget', () => {
    it('resolves `.` against the shell directory to the folder to open', () => {
        expect(resolveLaunchTarget(['.'], '/Users/me/project', kindOf)).toEqual({
            kind: 'directory',
            path: '/Users/me/project',
        });
    });

    it('resolves relative files and folders and keeps absolute paths', () => {
        expect(resolveLaunchTarget(['README.md'], '/Users/me/project', kindOf)).toEqual({
            kind: 'file',
            path: '/Users/me/project/README.md',
        });
        expect(resolveLaunchTarget(['/Users/me/project/src'], '/tmp', kindOf)).toEqual({
            kind: 'directory',
            path: '/Users/me/project/src',
        });
    });

    it('skips switches macOS and Chromium add, deep links, and flag values', () => {
        const args = [
            '-psn_0_12345',
            '--allow-file-access-from-files',
            'nimbalyst://open?x=1',
            '--workspace',
            '/Users/me/other',
            'src',
        ];
        expect(resolveLaunchTarget(args, '/Users/me/project', kindOf)).toEqual({
            kind: 'directory',
            path: '/Users/me/project/src',
        });
    });

    it('reports a path that does not exist instead of dropping it', () => {
        expect(resolveLaunchTarget(['nope'], '/Users/me/project', kindOf)).toEqual({
            kind: 'missing',
            path: '/Users/me/project/nope',
        });
    });

    it('returns null when no path was given', () => {
        expect(resolveLaunchTarget([], '/Users/me', kindOf)).toBeNull();
        expect(resolveLaunchTarget(['--safe-mode'], '/Users/me', kindOf)).toBeNull();
    });
});
