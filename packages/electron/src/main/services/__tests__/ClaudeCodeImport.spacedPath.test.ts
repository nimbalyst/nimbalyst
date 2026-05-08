/**
 * Regression test for #170: importer was using a different path encoder than
 * the scanner, so workspace paths containing spaces (or any non-alphanumeric)
 * scanned correctly but failed to import with ENOENT.
 *
 * Builds a tiny fixture under a tmp dir using Claude Code's actual encoder
 * and verifies that:
 *  1. scanAllSessions() finds the session for a workspace path with a space
 *  2. syncSession() can read that session file (no ENOENT)
 *  3. claude-code:sync-sessions surfaces failure when every sync fails
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { encodeWorkspaceDir, scanAllSessions } from '../ClaudeCodeSessionScanner';
import { syncSession } from '../ClaudeCodeSessionSync';

const WORKSPACE_PATH = '/Users/test/Desktop/Nimbalyst Projects/Test Nimbalyst';
const ENCODED = encodeWorkspaceDir(WORKSPACE_PATH);
const SESSION_ID = '218341c0-aaaa-4bbb-8ccc-dddddddddddd';
const TIMESTAMP = '2026-04-01T10:00:00.000Z';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-cc-spaced-'));
  process.env.NIMBALYST_CLAUDE_PROJECTS_DIR = tmpRoot;

  // Mirror what Claude Code writes: a workspace dir under
  // ~/.claude/projects/ named with the encoded path, containing a JSONL.
  const workspaceDir = path.join(tmpRoot, ENCODED);
  await fs.mkdir(workspaceDir, { recursive: true });
  const jsonl = [
    {
      uuid: 'u1',
      sessionId: SESSION_ID,
      timestamp: TIMESTAMP,
      cwd: WORKSPACE_PATH,
      type: 'user',
      message: { role: 'user', content: 'Hi' },
    },
    {
      uuid: 'u2',
      sessionId: SESSION_ID,
      timestamp: TIMESTAMP,
      cwd: WORKSPACE_PATH,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
    .map(e => JSON.stringify(e))
    .join('\n');
  await fs.writeFile(path.join(workspaceDir, `${SESSION_ID}.jsonl`), jsonl, 'utf-8');
});

afterEach(async () => {
  delete process.env.NIMBALYST_CLAUDE_PROJECTS_DIR;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Claude Code import for workspace paths with spaces', () => {
  it('encodes the workspace path the same way Claude Code does', () => {
    expect(ENCODED).toBe('-Users-test-Desktop-Nimbalyst-Projects-Test-Nimbalyst');
  });

  it('scanner finds the session under the spaced workspace path', async () => {
    const sessions = await scanAllSessions(WORKSPACE_PATH);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(SESSION_ID);
    expect(sessions[0].workspacePath).toBe(WORKSPACE_PATH);
  });

  it('importer reads the same file the scanner found (no ENOENT)', async () => {
    const [metadata] = await scanAllSessions(WORKSPACE_PATH);
    expect(metadata).toBeDefined();

    // Minimal in-memory stand-ins for the SessionStore / AgentMessagesStore
    // contracts that syncSession actually exercises. Anything else throws if
    // touched, so the test stays focused on path resolution.
    const created: any[] = [];
    const messages: any[] = [];
    const sessionStore: any = {
      get: async () => null,
      create: async (s: any) => {
        created.push(s);
      },
      updateMetadata: async () => {},
    };
    const messagesStore: any = {
      list: async () => [],
      create: async (m: any) => {
        messages.push(m);
      },
    };

    const result = await syncSession(sessionStore, messagesStore, metadata);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.messagesAdded).toBeGreaterThan(0);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(SESSION_ID);
  });
});
