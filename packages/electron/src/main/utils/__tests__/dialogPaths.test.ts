import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectDialogDefaultPath, selectedDialogDirectory, usableDirectory } from '../dialogPaths';

describe('dialogPaths', () => {
  it('uses the active workspace for contextual dialogs', () => {
    expect(selectDialogDefaultPath({
      workspacePath: '/workspace/active',
      lastDirectory: '/previous',
      documentsPath: '/documents',
    })).toBe('/workspace/active');
  });

  it('uses the last directory for generic dialogs', () => {
    expect(selectDialogDefaultPath({
      workspacePath: null,
      lastDirectory: '/previous',
      documentsPath: '/documents',
    })).toBe('/previous');
  });

  it('falls back to Documents before Electron can default to Downloads', () => {
    expect(selectDialogDefaultPath({
      workspacePath: null,
      documentsPath: '/documents',
    })).toBe('/documents');
  });

  it('resolves relative suggested paths under the contextual directory', () => {
    expect(selectDialogDefaultPath({
      explicitPath: 'export.pdf',
      workspacePath: '/workspace/active',
      documentsPath: '/documents',
    })).toBe('/workspace/active/export.pdf');
  });

  it('preserves an explicit absolute path', () => {
    expect(selectDialogDefaultPath({
      explicitPath: '/chosen/export.pdf',
      workspacePath: '/workspace/active',
      documentsPath: '/documents',
    })).toBe('/chosen/export.pdf');
  });

  it('retains the filename while applying a suggested name', () => {
    expect(selectDialogDefaultPath({
      workspacePath: '/workspace/active',
      documentsPath: '/documents',
      suggestedName: 'untitled.md',
    })).toBe('/workspace/active/untitled.md');
  });

  it('remembers a file parent and a selected directory directly', () => {
    expect(selectedDialogDirectory('/chosen/file.md', 'file')).toBe('/chosen');
    expect(selectedDialogDirectory('/chosen/project', 'directory')).toBe('/chosen/project');
  });
});

describe('usableDirectory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-dialogpaths-'));
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('accepts an existing directory', () => {
    expect(usableDirectory(tmpRoot)).toBe(tmpRoot);
  });

  it('rejects a directory that no longer exists', () => {
    // A remembered project that was deleted or lives on an unmounted volume.
    expect(usableDirectory(path.join(tmpRoot, 'deleted-project'))).toBeUndefined();
  });

  it('rejects a path that exists but is a file', () => {
    const filePath = path.join(tmpRoot, 'not-a-dir.md');
    fs.writeFileSync(filePath, '');
    expect(usableDirectory(filePath)).toBeUndefined();
  });

  it('rejects empty and nullish input', () => {
    expect(usableDirectory(undefined)).toBeUndefined();
    expect(usableDirectory(null)).toBeUndefined();
    expect(usableDirectory('')).toBeUndefined();
  });

  it('falls back past an unusable remembered directory to Documents', () => {
    expect(selectDialogDefaultPath({
      workspacePath: usableDirectory(path.join(tmpRoot, 'gone')) ?? null,
      lastDirectory: usableDirectory(path.join(tmpRoot, 'also-gone')),
      documentsPath: '/documents',
    })).toBe('/documents');
  });
});
