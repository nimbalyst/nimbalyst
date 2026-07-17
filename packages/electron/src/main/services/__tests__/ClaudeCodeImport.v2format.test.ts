/**
 * Tests for Claude Code 2.1.x JSONL format support.
 *
 * Builds a fixture workspace under a tmp dir, points the scanner at it via
 * the `NIMBALYST_CLAUDE_PROJECTS_DIR` env var, and verifies:
 *  - Sidecar directories (subagents/, tool-results/) are detected
 *  - sessions-index.json fast path is used when present
 *  - Title resolution prefers `aiTitle` over `summary`
 *  - Externalised tool-results are inlined via the `<persisted-output>` marker
 *  - Subagent JSONL files become raw messages tagged with parent_tool_use_id
 *  - Sync status is timestamp-based, not entry-count-based
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  extractSessionMetadata,
  scanAllSessions,
  readSessionsIndex,
} from '../ClaudeCodeSessionScanner';

let tmpRoot: string;

const WORKSPACE_PATH = '/Users/test/sources/sample-project';
const ESCAPED = WORKSPACE_PATH.replace(/\//g, '-');
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SUBAGENT_ID = 'a1b2c3d4';
const SUBAGENT_TOOL_USE_ID = 'toolu_subagent_1';
const PERSISTED_TOOL_USE_ID = 'toolu_persisted_1';
const PERSISTED_FILE_NAME = `${PERSISTED_TOOL_USE_ID}.txt`;
const PERSISTED_FULL_OUTPUT = 'FULL EXTERNAL TOOL OUTPUT, much larger than 2KB in real life.';

const T0 = '2026-04-01T10:00:00.000Z';
const T1 = '2026-04-01T10:00:05.000Z';
const T2 = '2026-04-01T10:00:10.000Z';
const T3 = '2026-04-01T10:00:15.000Z';
const T4 = '2026-04-01T10:00:20.000Z';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-cc-fixture-'));
  process.env.NIMBALYST_CLAUDE_PROJECTS_DIR = tmpRoot;
  await buildFixtureWorkspace(tmpRoot);
});

afterEach(async () => {
  delete process.env.NIMBALYST_CLAUDE_PROJECTS_DIR;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Claude Code v2 format support', () => {
  it('extractSessionMetadata picks up aiTitle, slug, sidecar flags, and richer usage', async () => {
    const filePath = path.join(tmpRoot, ESCAPED, `${SESSION_ID}.jsonl`);
    const meta = await extractSessionMetadata(filePath);

    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe(SESSION_ID);
    expect(meta!.title).toBe('AI title wins'); // aiTitle preferred over summary
    expect(meta!.slug).toBe('agile-cooking-gosling');
    expect(meta!.hasSubagents).toBe(true);
    expect(meta!.hasExternalToolResults).toBe(true);
    expect(meta!.tokenUsage.inputTokens).toBe(10);
    expect(meta!.tokenUsage.outputTokens).toBe(20);
    expect(meta!.tokenUsage.cacheCreationInputTokens).toBe(100);
    expect(meta!.tokenUsage.cacheReadInputTokens).toBe(50);
  });

  it('extractSessionMetadata falls back to summary entry when aiTitle is missing', async () => {
    const filePath = path.join(tmpRoot, ESCAPED, `${LEGACY_SESSION_ID}.jsonl`);
    const meta = await extractSessionMetadata(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('Legacy summary title');
    expect(meta!.hasSubagents).toBe(false);
    expect(meta!.hasExternalToolResults).toBe(false);
    expect(meta!.slug).toBeNull();
  });

  it('readSessionsIndex returns the parsed index when present', async () => {
    const index = await readSessionsIndex(ESCAPED);
    expect(index).not.toBeNull();
    expect(index!.version).toBe(1);
    expect(index!.entries).toHaveLength(2);
    expect(index!.entries.map(e => e.sessionId).sort()).toEqual(
      [SESSION_ID, LEGACY_SESSION_ID].sort(),
    );
  });

  it('uses the directory listing as source of truth and filters out sidechains named in the index', async () => {
    // Drop a stray .jsonl file representing a sidechain session, then mark
    // that sessionId as a sidechain in sessions-index.json. The scan should
    // pick up the on-disk main sessions but skip the sidechain one.
    const sidechainId = '99999999-9999-4999-8999-999999999999';
    await fs.writeFile(
      path.join(tmpRoot, ESCAPED, `${sidechainId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'side-u1',
        sessionId: sidechainId,
        timestamp: T0,
        message: { role: 'user', content: 'side' },
        cwd: WORKSPACE_PATH,
      }) + '\n',
    );

    const indexPath = path.join(tmpRoot, ESCAPED, 'sessions-index.json');
    const existing = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    existing.entries.push({
      sessionId: sidechainId,
      fullPath: path.join(tmpRoot, ESCAPED, `${sidechainId}.jsonl`),
      fileMtime: Date.now(),
      messageCount: 1,
      created: T0,
      modified: T0,
      gitBranch: 'main',
      projectPath: WORKSPACE_PATH,
      isSidechain: true,
    });
    await fs.writeFile(indexPath, JSON.stringify(existing));

    const sessions = await scanAllSessions(WORKSPACE_PATH);
    expect(sessions.map(s => s.sessionId).sort()).toEqual(
      [SESSION_ID, LEGACY_SESSION_ID].sort(),
    );
  });

  it('falls back gracefully when the index has stale fullPath references', async () => {
    // Real-world bug repro: the user's sessions-index.json had hundreds of
    // entries pointing at .jsonl files that no longer exist. We must still
    // discover the real files in the directory.
    const indexPath = path.join(tmpRoot, ESCAPED, 'sessions-index.json');
    const stale = {
      version: 1,
      entries: Array.from({ length: 5 }, (_, i) => ({
        sessionId: `stale-${i}`,
        fullPath: path.join(tmpRoot, ESCAPED, `stale-${i}.jsonl`),
        fileMtime: Date.now(),
        messageCount: 0,
        created: T0,
        modified: T0,
        gitBranch: 'main',
        projectPath: WORKSPACE_PATH,
        isSidechain: false,
      })),
    };
    await fs.writeFile(indexPath, JSON.stringify(stale));

    const sessions = await scanAllSessions(WORKSPACE_PATH);
    expect(sessions.map(s => s.sessionId).sort()).toEqual(
      [SESSION_ID, LEGACY_SESSION_ID].sort(),
    );
  });
});

describe('Claude Code v2 sync', () => {
  // Load the sync module once. It pulls in the whole @nimbalyst/runtime graph;
  // doing it inline in the first test made that test bear the full first-time
  // compile cost and flake past the 5s timeout under full-suite load.
  let syncSessions: typeof import('../ClaudeCodeSessionSync').syncSessions;
  beforeAll(async () => {
    ({ syncSessions } = await import('../ClaudeCodeSessionSync'));
  });

  it('imports follow-up user prompts as input direction even when parentUuid is set', async () => {
    // Repro of the live-import bug: 2.1.x threads parentUuid on every entry
    // so user prompts after the first turn have a parentUuid. They must
    // still be imported as user input, not as system messages.
    const stored: Array<{ direction: string; content: string }> = [];

    const fakeSessionStore: any = {
      get: async () => null,
      create: async () => {},
      updateMetadata: async () => {},
      list: async () => [],
    };
    const fakeMessagesStore: any = {
      list: async () => [],
      create: async (m: any) => { stored.push({ direction: m.direction, content: m.content }); },
    };

    // Build a minimal session: first user prompt (no parent), assistant
    // reply, then a follow-up user prompt WITH a parentUuid pointing at the
    // assistant's uuid. Both prompts must come back as direction='input'.
    const followupSessionId = '33333333-3333-4333-8333-333333333333';
    const filePath = path.join(tmpRoot, ESCAPED, `${followupSessionId}.jsonl`);
    const entries = [
      {
        type: 'user',
        uuid: 'p1',
        sessionId: followupSessionId,
        timestamp: T0,
        message: { role: 'user', content: 'first prompt' },
        cwd: WORKSPACE_PATH,
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'p1',
        sessionId: followupSessionId,
        timestamp: T1,
        message: {
          id: 'msg_a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: 'user',
        uuid: 'p2',
        parentUuid: 'a1', // <-- threaded follow-up prompt
        sessionId: followupSessionId,
        timestamp: T2,
        message: { role: 'user', content: 'follow-up prompt' },
        cwd: WORKSPACE_PATH,
      },
    ];
    await fs.writeFile(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const meta = await extractSessionMetadata(filePath);
    expect(meta).not.toBeNull();
    await syncSessions(fakeSessionStore, fakeMessagesStore, [meta!]);

    const inputs = stored
      .filter(m => m.direction === 'input')
      .map(m => {
        try { return JSON.parse(m.content).prompt as string; } catch { return ''; }
      });

    expect(inputs).toEqual(['first prompt', 'follow-up prompt']);
  });

  it('skips CLI bookkeeping (slash commands, command output) wrapped in user-role messages', async () => {
    const stored: Array<{ direction: string; content: string }> = [];
    const fakeSessionStore: any = { get: async () => null, create: async () => {}, updateMetadata: async () => {}, list: async () => [] };
    const fakeMessagesStore: any = {
      list: async () => [],
      create: async (m: any) => { stored.push({ direction: m.direction, content: m.content }); },
    };

    const sid = '44444444-4444-4444-8444-444444444444';
    const filePath = path.join(tmpRoot, ESCAPED, `${sid}.jsonl`);
    const entries = [
      {
        type: 'user',
        uuid: 'b1',
        sessionId: sid,
        timestamp: T0,
        message: { role: 'user', content: '<command-name>/login</command-name><command-message>login</command-message>' },
        cwd: WORKSPACE_PATH,
      },
      {
        type: 'user',
        uuid: 'b2',
        sessionId: sid,
        timestamp: T1,
        message: { role: 'user', content: '<local-command-stdout>Login successful</local-command-stdout>' },
        cwd: WORKSPACE_PATH,
      },
      {
        type: 'user',
        uuid: 'p1',
        parentUuid: 'b2',
        sessionId: sid,
        timestamp: T2,
        message: { role: 'user', content: 'real prompt' },
        cwd: WORKSPACE_PATH,
      },
    ];
    await fs.writeFile(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const meta = await extractSessionMetadata(filePath);
    await syncSessions(fakeSessionStore, fakeMessagesStore, [meta!]);

    const inputs = stored
      .filter(m => m.direction === 'input')
      .map(m => { try { return JSON.parse(m.content).prompt; } catch { return ''; } });

    // Only the real prompt should land in the input direction. The two
    // bookkeeping entries must NOT show up as user prompts.
    expect(inputs).toEqual(['real prompt']);
  });

  it('inlines persisted-output references and ingests subagent jsonl as parent-session messages', async () => {
    const stored: Array<{ direction: string; content: string }> = [];
    let createdSession: any = null;

    const fakeSessionStore: any = {
      get: async () => null,
      create: async (s: any) => { createdSession = s; },
      updateMetadata: async () => {},
      list: async () => [],
    };
    const fakeMessagesStore: any = {
      list: async () => [],
      create: async (m: any) => { stored.push({ direction: m.direction, content: m.content }); },
    };

    const meta = await extractSessionMetadata(
      path.join(tmpRoot, ESCAPED, `${SESSION_ID}.jsonl`),
    );
    expect(meta).not.toBeNull();
    const results = await syncSessions(fakeSessionStore, fakeMessagesStore, [meta!]);
    expect(results[0].success).toBe(true);

    // Session row should preserve the Claude Code session id verbatim so the
    // SDK can resume it.
    expect(createdSession.providerSessionId).toBe(SESSION_ID);
    expect(createdSession.provider).toBe('claude-code');

    // The full external tool-result content should have been inlined.
    const inlined = stored.find(m => m.content.includes(PERSISTED_FULL_OUTPUT));
    expect(inlined, 'expected persisted-output content to be inlined').toBeDefined();

    // Subagent assistant entries should be tagged with parent_tool_use_id =
    // <agentId> so the canonical parser routes them under the existing
    // subagent_id pathway.
    const subagentMessage = stored.find(m => {
      try {
        const p = JSON.parse(m.content);
        return p.parent_tool_use_id === SUBAGENT_ID && p.type === 'assistant';
      } catch {
        return false;
      }
    });
    expect(subagentMessage, 'expected at least one subagent-tagged assistant message').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

async function buildFixtureWorkspace(root: string): Promise<void> {
  const workspaceDir = path.join(root, ESCAPED);
  await fs.mkdir(workspaceDir, { recursive: true });

  // sessions-index.json
  await fs.writeFile(
    path.join(workspaceDir, 'sessions-index.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: SESSION_ID,
          fullPath: path.join(workspaceDir, `${SESSION_ID}.jsonl`),
          fileMtime: Date.now(),
          firstPrompt: 'help me with X',
          summary: 'Sample v2 session',
          messageCount: 6,
          created: T0,
          modified: T4,
          gitBranch: 'main',
          projectPath: WORKSPACE_PATH,
          isSidechain: false,
        },
        {
          sessionId: LEGACY_SESSION_ID,
          fullPath: path.join(workspaceDir, `${LEGACY_SESSION_ID}.jsonl`),
          fileMtime: Date.now(),
          firstPrompt: 'legacy hello',
          summary: 'Legacy summary title',
          messageCount: 3,
          created: T0,
          modified: T1,
          gitBranch: 'main',
          projectPath: WORKSPACE_PATH,
          isSidechain: false,
        },
      ],
    }),
  );

  // ----- v2 main session -----
  const mainEntries: any[] = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: SESSION_ID,
      timestamp: T0,
      message: { role: 'user', content: 'Hello there' },
      cwd: WORKSPACE_PATH,
      gitBranch: 'main',
      slug: 'agile-cooking-gosling',
      aiTitle: 'AI title wins',
    },
    {
      type: 'attachment',
      uuid: 'a1',
      sessionId: SESSION_ID,
      timestamp: T0,
      attachment: { type: 'deferred_tools_delta', addedNames: ['TodoWrite', 'WebFetch'] },
    },
    {
      type: 'assistant',
      uuid: 'asst1',
      parentUuid: 'u1',
      sessionId: SESSION_ID,
      timestamp: T1,
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'thinking', thinking: 'pondering...', signature: 'sig1' },
          { type: 'text', text: 'Hello back!' },
          {
            type: 'tool_use',
            id: SUBAGENT_TOOL_USE_ID,
            name: 'Task',
            input: { prompt: 'do something', subagent_type: 'Explore' },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'asst1',
      sessionId: SESSION_ID,
      timestamp: T2,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: PERSISTED_TOOL_USE_ID,
            content:
              `<persisted-output>\nOutput too large (3.0KB). Full output saved to: ${path.join(
                workspaceDir,
                SESSION_ID,
                'tool-results',
                PERSISTED_FILE_NAME,
              )}\n\nPreview (first 2KB):\nshort preview text\n</persisted-output>`,
          },
        ],
      },
    },
    {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: T3,
      sessionId: SESSION_ID,
    },
    {
      type: 'last-prompt',
      lastPrompt: 'previous prompt',
      sessionId: SESSION_ID,
    },
  ];
  await fs.writeFile(
    path.join(workspaceDir, `${SESSION_ID}.jsonl`),
    mainEntries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );

  // Sidecar dirs
  const sidecarDir = path.join(workspaceDir, SESSION_ID);
  const subagentsDir = path.join(sidecarDir, 'subagents');
  const toolResultsDir = path.join(sidecarDir, 'tool-results');
  await fs.mkdir(subagentsDir, { recursive: true });
  await fs.mkdir(toolResultsDir, { recursive: true });

  await fs.writeFile(
    path.join(toolResultsDir, PERSISTED_FILE_NAME),
    PERSISTED_FULL_OUTPUT,
  );

  // Subagent JSONL: a brief sidechain conversation under SUBAGENT_ID
  const subagentEntries: any[] = [
    {
      type: 'user',
      uuid: 'sa-u1',
      isSidechain: true,
      agentId: SUBAGENT_ID,
      sessionId: SESSION_ID,
      timestamp: T2,
      message: { role: 'user', content: 'subagent prompt' },
    },
    {
      type: 'assistant',
      uuid: 'sa-a1',
      parentUuid: 'sa-u1',
      isSidechain: true,
      agentId: SUBAGENT_ID,
      sessionId: SESSION_ID,
      timestamp: T3,
      message: {
        id: 'sa-msg-1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'subagent reply' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    },
  ];
  await fs.writeFile(
    path.join(subagentsDir, `agent-${SUBAGENT_ID}.jsonl`),
    subagentEntries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
  await fs.writeFile(
    path.join(subagentsDir, `agent-${SUBAGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: 'Test subagent' }),
  );

  // ----- legacy single-file session (no sidecar, no aiTitle) -----
  const legacyEntries: any[] = [
    {
      type: 'summary',
      summary: 'Legacy summary title',
      sessionId: LEGACY_SESSION_ID,
      timestamp: T0,
    },
    {
      type: 'user',
      uuid: 'l-u1',
      sessionId: LEGACY_SESSION_ID,
      timestamp: T0,
      message: { role: 'user', content: 'legacy hello' },
      cwd: WORKSPACE_PATH,
    },
    {
      type: 'assistant',
      uuid: 'l-a1',
      parentUuid: 'l-u1',
      sessionId: LEGACY_SESSION_ID,
      timestamp: T1,
      message: {
        id: 'l-msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'legacy reply' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    },
  ];
  await fs.writeFile(
    path.join(workspaceDir, `${LEGACY_SESSION_ID}.jsonl`),
    legacyEntries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}
