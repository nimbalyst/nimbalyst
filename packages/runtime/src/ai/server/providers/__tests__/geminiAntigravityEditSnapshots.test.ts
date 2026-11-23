// @vitest-environment node
/**
 * Guards the file-tracking half of the Gemini ACP provider.
 *
 * Gemini now runs over `agy acp` via the shared `CodexACPProtocol`, so file
 * tracking uses the ACP `onBeforeFileWrite` / `onTurnFilesEdited` hooks plus
 * `PROVIDER_EDIT_TOOL_NAMES` pre-edit baselines, while keeping the watcher on
 * (`'tool-args'`) so shell-driven deletes and renames stay visible.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexACPProtocol } from '../../protocols/CodexACPProtocol';
import {
  BUILTIN_FILE_CHANGE_FIDELITY,
  PROVIDER_EDIT_TOOL_NAMES,
  attributionModeForFileChangeFidelity,
} from '../../providerFileTracking';

function codexFixturePath(): string {
  return fileURLToPath(new URL('../../protocols/__tests__/fixtures/mockCodexAcpAgent.mjs', import.meta.url));
}

describe('gemini file-tracking declaration', () => {
  it('declares tool-args so the watcher keeps attributing shell-driven changes', () => {
    expect(BUILTIN_FILE_CHANGE_FIDELITY['antigravity-gemini-agent']).toBe('tool-args');
    expect(attributionModeForFileChangeFidelity('tool-args')).toBe('fuzzy');
  });

  it('lists ACP edit tools so pre-edit baselines are captured before edits land', () => {
    expect(PROVIDER_EDIT_TOOL_NAMES['antigravity-gemini-agent']).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'ApplyPatch', 'edit_file', 'write_file']),
    );
  });
});

describe('Gemini ACP write hooks', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('invokes onBeforeFileWrite and onTurnFilesEdited with the Nimbalyst session id', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-acp-write-hooks-'));
    const beforeWrites: Array<{ filePath: string; sessionId: string | undefined }> = [];
    const turnEdits: Array<{ files: string[]; sessionId: string | undefined }> = [];

    const protocol = new CodexACPProtocol('', {
      platform: 'antigravity-gemini-acp',
      apiKeyEnvVar: null,
      command: process.execPath,
      args: [codexFixturePath()],
      onPermissionRequest: async () => ({ decision: 'allow', scope: 'once' }),
      onBeforeFileWrite: vi.fn(async (filePath, sessionId) => {
        beforeWrites.push({ filePath, sessionId });
      }),
      onTurnFilesEdited: vi.fn(async (filePaths, sessionId) => {
        turnEdits.push({ files: [...filePaths], sessionId });
      }),
    });
    cleanups.push(() => {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    });

    const session = await protocol.createSession({ workspacePath });
    for await (const _event of protocol.sendMessage(session, {
      content: 'edit target',
      sessionId: 'nimbalyst-session-42',
    })) {
      // consume
    }

    const expectedPath = path.join(workspacePath, 'acp-target.txt');
    expect(beforeWrites).toEqual([{ filePath: expectedPath, sessionId: 'nimbalyst-session-42' }]);
    expect(turnEdits).toEqual([{ files: [expectedPath], sessionId: 'nimbalyst-session-42' }]);
  }, 15000);
});
