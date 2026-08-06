// @vitest-environment node

import { describe, expect, it } from 'vitest';
import path from 'path';
import {
  resolveAttachmentStagingRoot,
  resolveAttachmentStagingAllowDirectories,
  resolveSavedAttachmentDirectory,
  resolveWorkspaceAttachmentStagingDirectory,
  workspacePathToAttachmentDir,
} from '../attachmentStagingRoot';

describe('attachmentStagingRoot', () => {
  const workspace = path.join(path.sep, 'workspaces', 'project');
  const tempPath = path.join(path.sep, 'system-temp');

  it.each([
    ['temp', undefined, tempPath],
    ['workspace', undefined, path.join(workspace, 'nimbalyst-local', 'attachments')],
    ['custom', path.join(path.sep, 'attachment-root'), path.join(path.sep, 'attachment-root')],
  ] as const)('resolves %s mode', (mode, customPath, expected) => {
    expect(resolveAttachmentStagingRoot(workspace, {
      config: { mode, customPath },
      tempPath,
      ensureWritable: () => {},
    })).toBe(path.normalize(expected));
  });

  it('falls back to temp when the configured root is not writable', () => {
    const customPath = path.join(path.sep, 'read-only');
    expect(resolveAttachmentStagingRoot(workspace, {
      config: { mode: 'custom', customPath },
      tempPath,
      ensureWritable: (candidate) => {
        if (candidate === customPath) throw new Error('EACCES');
      },
    })).toBe(path.normalize(tempPath));
  });

  it('falls back to temp for a missing or relative custom path', () => {
    expect(resolveAttachmentStagingRoot(workspace, {
      config: { mode: 'custom', customPath: 'relative/path' },
      tempPath,
      ensureWritable: () => {},
    })).toBe(path.normalize(tempPath));
  });

  it('scopes external roots by workspace but keeps workspace mode at the configured root', () => {
    const external = resolveWorkspaceAttachmentStagingDirectory(workspace, {
      config: { mode: 'temp' },
      tempPath,
      ensureWritable: () => {},
    });
    expect(external).toBe(path.join(tempPath, 'nimbalyst-attachments', workspacePathToAttachmentDir(workspace)));

    const local = resolveWorkspaceAttachmentStagingDirectory(workspace, {
      config: { mode: 'workspace' },
      tempPath,
      ensureWritable: () => {},
    });
    expect(local).toBe(path.join(workspace, 'nimbalyst-local', 'attachments'));
  });

  it('creates a stable directory key from Windows-style workspace paths', () => {
    expect(workspacePathToAttachmentDir(path.win32.join('C:\\', 'Users', 'Ada', 'Project')))
      .toBe('C--Users-Ada-Project');
  });

  it.each([
    { mode: 'temp' as const },
    { mode: 'workspace' as const },
    { mode: 'custom' as const, customPath: path.join(path.sep, 'attachment-root') },
  ])('keeps CLI allow directories and saved attachment storage on the same root in $mode mode', (config) => {
    const [allowDirectory] = resolveAttachmentStagingAllowDirectories(workspace, {
      config,
      tempPath,
      ensureWritable: () => {},
    });
    expect(path.dirname(resolveSavedAttachmentDirectory(allowDirectory))).toBe(allowDirectory);
  });
});
