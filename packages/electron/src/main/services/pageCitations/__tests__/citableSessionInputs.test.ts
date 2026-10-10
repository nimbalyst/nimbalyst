// @vitest-environment node
/**
 * The citable inputs of one session, read from real `ai_agent_messages` rows on
 * both database backends. The rows are the shapes each provider actually
 * writes: Claude Code SDK prompts and tool_result answers, the genuine CLI's
 * `{prompt}` rows and synthetic `nimbalyst_tool_use` / `_result` rows, Codex's
 * plain prompts and `ask_user_question_response` rows, and agent sends that
 * must never be cited as a person's words.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { listSessionCitableInputs } from '../citableSessionInputs';
import { runListCitableInputs } from '../listCitableInputs';
import { findCitations } from '@nimbalyst/runtime/core/citationSyntax';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const SESSION = 'session-1';
const BASE = Date.parse('2026-09-30T10:00:00.000Z');

interface SeedRow {
  source: string;
  direction: 'input' | 'output';
  content: unknown;
  metadata?: Record<string, unknown>;
  providerMessageId?: string;
  hidden?: boolean;
}

const human = { promptProvenance: { actor: 'human', origin: 'composer' } };
const agent = { promptProvenance: { actor: 'agent', origin: 'session-orchestration' } };

const SEED: SeedRow[] = [
  // Claude Code SDK: the person's prompt, with the SDK's message uuid.
  { source: 'claude-code', direction: 'input', content: { prompt: 'Use one shared DataTable everywhere', options: {} }, metadata: human, providerMessageId: 'sdk-uuid-1' },
  // An orchestrator's send into this session is not a person's words.
  { source: 'claude-code', direction: 'input', content: { prompt: 'Run the targeted tests and report', options: {} }, metadata: agent },
  { source: 'nimbalyst-meta-agent', direction: 'input', content: 'Implement slice P5', metadata: agent },
  { source: 'claude-code', direction: 'input', content: { prompt: '<SYSTEM_REMINDER>stay on task</SYSTEM_REMINDER>' } },
  // Claude Code SDK AskUserQuestion: the question row, then the SDK's tool_result.
  {
    source: 'claude-code', direction: 'output',
    content: { type: 'nimbalyst_tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which table approach?', header: 'Tables', options: [{ label: 'RevoGrid' }, { label: 'TanStack' }] }] } },
  },
  {
    source: 'claude-code', direction: 'output',
    content: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'User has answered your questions: "Which table approach?"="Building it means building the whole thing". You can now continue.' }] } },
  },
  // Genuine CLI: the typed prompt, then a PromptForUserInput answered with a note.
  { source: 'claude-code', direction: 'input', content: { prompt: 'Keep AG Grid out of it' }, metadata: human },
  {
    source: 'claude-code', direction: 'output',
    content: { type: 'nimbalyst_tool_use', id: 'cli_q2', name: 'mcp__nimbalyst__PromptForUserInput', input: { title: 'Table scope', fields: [
      { type: 'editText', id: 'notes', label: 'Anything else?', initialText: 'draft' },
      { type: 'singleSelect', id: 'pick', label: 'Library', options: [{ id: 'a', label: 'TanStack' }] },
    ] } },
  },
  {
    source: 'nimbalyst', direction: 'output',
    content: { type: 'request_user_input_response', promptId: 'cli_q2', answers: { notes: { type: 'editText', text: 'Keyboard handling and popup positioning stay in scope', edited: true }, pick: { type: 'singleSelect', selectedId: 'a' } }, cancelled: false, respondedAt: BASE, respondedBy: 'desktop' },
  },
  { source: 'claude-code', direction: 'output', content: { type: 'nimbalyst_tool_result', tool_use_id: 'cli_q2', result: '{"answers":{}}', is_error: false } },
  // Codex: a plain prompt with no provider id, then an answered question.
  { source: 'openai-codex', direction: 'input', content: 'Pick Mantine for standard components', metadata: { mode: 'agent' } },
  {
    source: 'openai-codex', direction: 'output',
    content: { type: 'ask_user_question_response', questionId: 'codex-q3', answers: { 'Ship it this week?': 'Yes' }, cancelled: false, respondedAt: BASE, respondedBy: 'mobile' },
  },
  // Cancelled and unanswered questions cite nothing.
  { source: 'openai-codex', direction: 'output', content: { type: 'ask_user_question_response', questionId: 'codex-q4', answers: {}, cancelled: true, respondedAt: BASE, respondedBy: 'desktop' } },
  { source: 'claude-code', direction: 'output', content: { type: 'nimbalyst_tool_use', id: 'toolu_q5', name: 'AskUserQuestion', input: { questions: [{ question: 'Still open?', header: 'Open', options: [{ label: 'Yes' }] }] } } },
  // The session read a shared page; its comments become citable.
  {
    source: 'claude-code', direction: 'output',
    content: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r1', name: 'mcp__nimbalyst-situational__readCollabDoc', input: { filePath: 'collab://org:o1:doc:d1' } }] } },
  },
];

async function openBackend(backend: 'sqlite' | 'pglite', dir: string): Promise<SQLiteDatabase | PGlite> {
  if (backend === 'sqlite') {
    const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), sampleRate: 0 });
    await db.initialize();
    return db;
  }
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, provider TEXT, workspace_id TEXT);
    CREATE TABLE ai_agent_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      provider_message_id TEXT
    );
  `);
  return db;
}

async function seed(db: SQLiteDatabase | PGlite): Promise<void> {
  await db.query(`INSERT INTO ai_sessions (id, provider, workspace_id) VALUES ($1, 'claude-code', '/project')`, [SESSION]);
  for (const [index, row] of SEED.entries()) {
    await db.query(
      `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content, metadata, hidden, provider_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        SESSION,
        new Date(BASE + index * 1000),
        row.source,
        row.direction,
        typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.hidden ?? false,
        row.providerMessageId ?? null,
      ],
    );
  }
}

/** The id CollabV3Sync gives a row that has no provider message id. */
function syncHashId(sessionId: string, createdAt: number, direction: string, content: string): string {
  return createHash('sha256')
    .update(`${sessionId}:${createdAt}:${direction}:${content.substring(0, 100)}`)
    .digest('hex')
    .slice(0, 32);
}

describe.each(['sqlite', 'pglite'] as const)('citable session inputs on %s', (backend) => {
  it('lists human prompts and answered questions with stable keys, and nothing an agent said', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'citable-inputs-'));
    const db = await openBackend(backend, dir);
    try {
      await seed(db);
      const inputs = await listSessionCitableInputs(db, SESSION, { author: 'Greg Hinkle', authorEmail: 'greg@example.com' });

      expect(inputs.map((input) => [input.kind, input.key, input.quote])).toEqual([
        ['prompt', 'sdk-uuid-1', 'Use one shared DataTable everywhere'],
        ['answer', 'toolu_q1', 'Building it means building the whole thing'],
        ['prompt', syncHashId(SESSION, BASE + 6000, 'input', JSON.stringify({ prompt: 'Keep AG Grid out of it' })), 'Keep AG Grid out of it'],
        ['answer', 'cli_q2', 'Keyboard handling and popup positioning stay in scope'],
        ['prompt', syncHashId(SESSION, BASE + 10000, 'input', 'Pick Mantine for standard components'), 'Pick Mantine for standard components'],
        ['answer', 'codex-q3', 'Yes'],
      ]);

      const [prompt, typedAnswer, , formAnswer] = inputs;
      expect(prompt).toMatchObject({ by: 'Greg Hinkle', email: 'greg@example.com', at: new Date(BASE).toISOString(), sessionId: SESSION });
      // The person's typed words are the quote; the question is the context.
      expect(typedAnswer).toMatchObject({ context: 'Which table approach?', typed: true });
      expect(formAnswer).toMatchObject({ context: 'Table scope', typed: true });
      expect(formAnswer.answer).toContain('Library: TanStack');
      expect(inputs[5]).toMatchObject({ context: 'Ship it this week?', typed: false });
      // The page editor reads each citation back to the same input and snapshot.
      for (const input of inputs) {
        const [occurrence] = findCitations(`A sentence. ${input.citation}`);
        expect(occurrence?.citation).toMatchObject({
          kind: 'human', sessionId: SESSION, inputKind: input.kind, key: input.key, by: 'Greg Hinkle', email: 'greg@example.com', at: input.at, quote: input.quote,
        });
      }
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds people\'s comments on the pages the session worked on, and filters by kind and text', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'citable-tool-'));
    const db = await openBackend(backend, dir);
    try {
      await seed(db);
      const readComments = vi.fn(async (page: string) => page === 'collab://org:o1:doc:d1'
        ? {
            document: { title: 'TanStack Table', uri: page },
            threads: [{
              id: 't1',
              quote: 'every data table',
              comments: [
                { id: 'c1', actor: { kind: 'user', displayName: 'Ana Ruiz' }, body: 'AG Grid is out: proven, but old.', createdAt: BASE + 60_000, deleted: false },
                { id: 'c2', actor: { kind: 'agent', sessionId: 's', sessionName: 'Agent' }, body: 'Noted.', createdAt: BASE + 61_000, deleted: false },
                { id: 'c3', actor: { kind: 'user', displayName: 'Ana Ruiz' }, body: 'removed', createdAt: BASE + 62_000, deleted: true },
                // Renamed since the roster was read: found by member id.
                { id: 'c4', actor: { kind: 'user', userId: asTeamMemberId('member-bo'), displayName: 'Bo L.' }, body: 'Keep Mantine.', createdAt: BASE + 63_000, deleted: false },
              ],
            }],
          }
        : { error: 'DOCUMENT_NOT_MOUNTED' });
      const roster = [
        { memberId: asTeamMemberId('member-ana'), name: 'Ana Ruiz', email: 'ana@example.com' },
        { memberId: asTeamMemberId('member-bo'), name: 'Bo Lindqvist', email: 'bo@example.com' },
      ];
      const deps = {
        db: () => db,
        author: () => ({ name: 'Greg Hinkle', email: 'greg@example.com' }),
        readComments,
        teamMembers: vi.fn(async () => roster),
      };
      const context = { sessionId: SESSION, workspacePath: '/project' };

      const comments = await runListCitableInputs({ kinds: ['comment'] }, context, deps);
      expect(readComments).toHaveBeenCalledWith('collab://org:o1:doc:d1', '/project');
      expect(comments.inputs.map((input) => [input.key, input.by, input.email, input.quote, input.context])).toEqual([
        ['d1~t1~c1', 'Ana Ruiz', 'ana@example.com', 'AG Grid is out: proven, but old.', 'TanStack Table: "every data table"'],
        ['d1~t1~c4', 'Bo L.', 'bo@example.com', 'Keep Mantine.', 'TanStack Table: "every data table"'],
      ]);
      expect(findCitations(comments.inputs[1]!.citation)[0]?.citation).toMatchObject({ email: 'bo@example.com' });

      const missing = await runListCitableInputs({ kinds: ['comment'], pages: ['collab://org:o1:doc:gone'] }, context, deps);
      expect(missing.inputs).toEqual([]);
      expect(missing.notes[0]).toContain('DOCUMENT_NOT_MOUNTED');

      const matched = await runListCitableInputs({ query: 'KEYBOARD' }, context, deps);
      expect(matched.inputs.map((input) => input.key)).toEqual(['cli_q2']);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
