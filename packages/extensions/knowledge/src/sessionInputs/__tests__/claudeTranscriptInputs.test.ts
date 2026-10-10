// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCitationLink } from '@nimbalyst/runtime/core/citationSyntax';
import { citableInputsFromTranscript, selectInputs } from '../claudeTranscriptInputs';
import { encodeProjectDir, locateTranscript } from '../claudeTranscriptLocator';
import { handleMessage, type ServerDeps } from '../server';

const FIXTURE = readFileSync(path.join(__dirname, 'fixtures', 'session-main.jsonl'), 'utf8');
const SESSION = '11111111-aaaa-4bbb-8ccc-000000000001';
const who = { sessionId: SESSION, by: 'Dana Lee', email: 'dana@example.com' };

describe('citable inputs from a Claude Code transcript', () => {
  const inputs = citableInputsFromTranscript(FIXTURE, who);

  it('lists only what the person typed: prompts, command arguments and question answers', () => {
    expect(inputs.map((input) => `${input.kind}:${input.key}`)).toEqual([
      'prompt:p-typed',
      'prompt:p-blocks',
      'prompt:p-legacy',
      'prompt:p-command',
      'answer:toolu_ASK1~0',
      'answer:toolu_ASK1~1',
    ]);
  });

  it('replaces pasted blocks, keeps the command as context, and snapshots who and when', () => {
    const [typed, , , command] = inputs;
    expect(typed).toMatchObject({ by: 'Dana Lee', email: 'dana@example.com', at: '2026-10-01T10:00:00.000Z', context: 'Prompt' });
    expect(typed.quote).toBe('Store flags in Flagship, not our own DO.\n[pasted]\nThat is final.');
    expect(typed.citation).not.toContain('secret');
    expect(command).toMatchObject({ context: '/knowledge-graph', quote: 'record that we chose Flagship' });
  });

  it('separates a typed note or Other text from the picked label, and keeps labels that contain a comma whole', () => {
    const [flags, sdks] = inputs.slice(4);
    expect(flags).toMatchObject({ context: 'Where do flags live?', quote: 'but feel free to revisit after launch', answer: 'Flagship, but feel free to revisit after launch', typed: true });
    expect(sdks).toMatchObject({ context: 'Which SDKs?', quote: 'Android can wait a quarter', answer: 'Web, iOS', typed: true });
  });

  it('builds citations the page editor reads back as a Claude Code session citation', () => {
    const match = /^\[([^\]]+)\]\(([^ )]+) "([^"]*)"\)$/.exec(inputs[4].citation)!;
    expect(parseCitationLink(match[1], match[2], match[3])).toMatchObject({
      kind: 'human', agent: 'claude-code', sessionId: SESSION, inputKind: 'answer', key: 'toolu_ASK1~0',
      by: 'Dana Lee', email: 'dana@example.com', quote: 'but feel free to revisit after launch',
    });
  });

  it('filters by kind and query and keeps the newest within the limit', () => {
    expect(selectInputs(inputs, { kinds: ['answer'] }).map((input) => input.key)).toEqual(['toolu_ASK1~0', 'toolu_ASK1~1']);
    expect(selectInputs(inputs, { query: 'FLAGSHIP' }).map((input) => input.key)).toEqual(['p-typed', 'p-command', 'toolu_ASK1~0']);
    expect(selectInputs(inputs, { limit: 2 }).map((input) => input.key)).toEqual(['toolu_ASK1~0', 'toolu_ASK1~1']);
  });
});

describe('locating the calling session transcript', () => {
  let root: string;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  const PROJECT = '/work/acme/widgets';
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const callLine = (id: string) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', id, name: 'list_session_inputs', input: {} }] } });

  function setup(files: Record<string, string>): string {
    root = mkdtempSync(path.join(tmpdir(), 'cc-transcripts-'));
    const dir = path.join(root, 'projects', encodeProjectDir(PROJECT));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  }

  const deps = (sessionId: string | undefined, extra: Partial<ServerDeps> = {}) => ({
    env: { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_CONFIG_DIR: root },
    timeoutMs: 200,
    pollMs: 10,
    ...extra,
  });

  it('encodes the project dir the way Claude Code names its folder', () => {
    expect(encodeProjectDir('/Users/dana/src/my_app.v2')).toBe('-Users-dana-src-my-app-v2');
  });

  it('picks the session whose transcript holds the calling tool use, with two sessions in one project', async () => {
    setup({ [`${A}.jsonl`]: `${callLine('toolu_A')}\n`, [`${B}.jsonl`]: `${callLine('toolu_B')}\n` });
    expect(await locateTranscript('toolu_B', deps(B))).toMatchObject({ ok: true, sessionId: B });
    expect(await locateTranscript('toolu_A', deps(A))).toMatchObject({ ok: true, sessionId: A });
  });

  it('finds the right file by the tool use when the session id in the env is stale, and never takes the newest file', async () => {
    const dir = setup({ [`${A}.jsonl`]: `${callLine('toolu_A')}\n`, [`${B}.jsonl`]: `${callLine('toolu_B')}\n` });
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(dir, `${A}.jsonl`), later, later);
    expect(await locateTranscript('toolu_B', deps(A))).toMatchObject({ ok: true, sessionId: B });
    // Nothing holds the call: refuse, even though a newest file exists and the env names a session.
    expect(await locateTranscript('toolu_NOWHERE', deps(A))).toMatchObject({ ok: false });
  });

  it('waits for the buffered write of the call to land', async () => {
    const dir = setup({ [`${B}.jsonl`]: '' });
    setTimeout(() => appendFileSync(path.join(dir, `${B}.jsonl`), `${callLine('toolu_LATE')}\n`), 40);
    expect(await locateTranscript('toolu_LATE', deps(B, { timeoutMs: 3000 }))).toMatchObject({ ok: true, sessionId: B });
  });

  it('answers a tools/call from the proven transcript only, and lists nothing without the call id', async () => {
    setup({ [`${A}.jsonl`]: `${FIXTURE}${callLine('toolu_A')}\n`, [`${B}.jsonl`]: `${callLine('toolu_B')}\n` });
    const call = (meta: object | undefined) => handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_session_inputs', arguments: { kinds: ['prompt'], by: 'Dana Lee' }, ...(meta ? { _meta: meta } : {}) } },
      deps(B, { gitIdentity: () => ({}) }),
    ) as Promise<{ result: { content: Array<{ text: string }> } }>;
    const found = JSON.parse((await call({ 'claudecode/toolUseId': 'toolu_A' })).result.content[0].text);
    expect(found.inputs.map((input: { key: string }) => input.key)).toEqual(['p-typed', 'p-blocks', 'p-legacy', 'p-command']);
    expect(found.inputs[0].sessionId).toBe(A);
    expect(JSON.parse((await call(undefined)).result.content[0].text)).toMatchObject({ inputs: [] });
  });

  it('maps a call from a subagent to its parent session, and refuses without a tool use id or a valid session id', async () => {
    setup({ [`${B}.jsonl`]: `${callLine('toolu_B')}\n`, [`${B}/subagents/agent-1.jsonl`]: `${callLine('toolu_SUB')}\n` });
    const found = await locateTranscript('toolu_SUB', deps(B));
    expect(found).toMatchObject({ ok: true, sessionId: B });
    expect(found.ok && found.path.endsWith(`${B}.jsonl`)).toBe(true);
    expect(await locateTranscript(undefined, deps(B))).toMatchObject({ ok: false });
    // A path-like id from the env is never joined into a path.
    expect(await locateTranscript('toolu_B', deps('../../etc/passwd', { env: { CLAUDE_CODE_SESSION_ID: '../x', CLAUDE_CONFIG_DIR: root } }))).toMatchObject({ ok: false });
  });
});
