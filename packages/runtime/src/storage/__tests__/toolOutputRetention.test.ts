// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isTombstoned,
  tombstoneAppServerEnvelope,
  tombstoneClaudeCodeChunk,
  tombstoneRawContent,
} from '../toolOutputRetention';
import { rawMessagesToCanonicalEvents } from '../../ai/server/transcript/projectRawMessages';
import type { RawMessage } from '../../ai/server/transcript/TranscriptTransformer';

const DATE = '2026-05-01T12:00:00.000Z';
const BIG_OUTPUT = 'stdout line\n'.repeat(5000);

function rawMessage(partial: Partial<RawMessage> & { content: string }): RawMessage {
  return {
    id: 1,
    sessionId: 'session-1',
    source: 'claude-code',
    direction: 'output',
    createdAt: new Date(DATE),
    ...partial,
  };
}

const TOOL_CALL = JSON.stringify({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } }],
  },
});

function toolResultRow(content: unknown) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content }],
    },
  });
}

describe('tombstoneRawContent', () => {
  it('shrinks an aged claude-code tool result and marks it', () => {
    const before = toolResultRow(BIG_OUTPUT);
    const after = tombstoneRawContent(before, 'claude-code', DATE);

    expect(after).not.toBeNull();
    expect(after!.length).toBeLessThan(before.length / 10);
    expect(after).toContain('Output discarded to reclaim disk');
    expect(after).toContain('2026-05-01');
    // The link back to the call it answers must survive.
    expect(after).toContain('toolu_01');
  });

  it('is idempotent -- a second pass issues no write', () => {
    const once = tombstoneRawContent(toolResultRow(BIG_OUTPUT), 'claude-code', DATE);
    expect(tombstoneRawContent(once!, 'claude-code', DATE)).toBeNull();
  });

  it('leaves a tool_use call untouched however large', () => {
    const bigWrite = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_02',
          name: 'Write',
          input: { content: 'plan line\n'.repeat(10_000) },
        }],
      },
    });
    expect(tombstoneRawContent(bigWrite, 'claude-code', DATE)).toBeNull();
  });

  it('leaves small results alone rather than paying a write to save nothing', () => {
    expect(tombstoneRawContent(toolResultRow('ok'), 'claude-code', DATE)).toBeNull();
  });

  it('refuses to guess at an unrecognized provider shape', () => {
    expect(tombstoneRawContent(toolResultRow(BIG_OUTPUT), 'some-new-agent', DATE)).toBeNull();
  });

  it('returns null on unparseable content instead of destroying it', () => {
    expect(tombstoneRawContent('not json at all', 'claude-code', DATE)).toBeNull();
  });
});

describe('tombstoneClaudeCodeChunk', () => {
  it('replaces an aged image with a text marker naming its type and size', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2000) } };
    const chunk = JSON.parse(toolResultRow([{ type: 'text', text: BIG_OUTPUT }, image]));

    const out = tombstoneClaudeCodeChunk(chunk, DATE) as typeof chunk;
    const blocks = out.message.content[0].content;

    expect(isTombstoned(blocks[0].text)).toBe(true);
    expect(blocks[1].type).toBe('text');
    expect(isTombstoned(blocks[1].text)).toBe(true);
    expect(blocks[1].text).toContain('image/png');
    // A second pass has nothing left to do.
    expect(tombstoneClaudeCodeChunk(out, DATE)).toBeNull();
  });

  it('discards an array sidecar whole, including the second copy of an image', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2000) } };
    const chunk = JSON.parse(toolResultRow([image]));
    chunk.tool_use_result = [{ type: 'text', text: 'ok' }, image];

    const out = tombstoneClaudeCodeChunk(chunk, DATE) as typeof chunk;

    expect(isTombstoned(out.tool_use_result)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('AAAA');
    expect(tombstoneClaudeCodeChunk(out, DATE)).toBeNull();
  });

  it('does not mutate its input', () => {
    const chunk = JSON.parse(toolResultRow(BIG_OUTPUT));
    tombstoneClaudeCodeChunk(chunk, DATE);
    expect(chunk.message.content[0].content).toBe(BIG_OUTPUT);
  });
});

describe('tombstoneAppServerEnvelope', () => {
  it('discards aggregatedOutput but keeps what the tool card renders', () => {
    const envelope = {
      method: 'item/completed',
      params: {
        item: {
          id: 'exec-1',
          type: 'commandExecution',
          status: 'completed',
          command: 'npm test',
          exitCode: 1,
          aggregatedOutput: BIG_OUTPUT,
        },
      },
    };

    const out = tombstoneAppServerEnvelope(envelope, DATE) as typeof envelope;

    expect(isTombstoned(out.params.item.aggregatedOutput)).toBe(true);
    expect(out.params.item.exitCode).toBe(1);
    expect(out.params.item.command).toBe('npm test');
    expect(out.params.item.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Shapes measured on a real 7 GB install (NIM-3661). Every fixture below is a
// sanitized copy of a row that the rewriter used to walk straight past, which
// is why the pass reported 0 bytes reclaimable against 1,020,087 candidates.
// ---------------------------------------------------------------------------

const ORIGINAL_FILE = '## [Unreleased]\n\n### Added\n- a thing\n'.repeat(1200);

/** claude-code Edit result: 199-byte `message`, ~46 KB `tool_use_result`. */
function editRowWithSidecar(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: 'toolu_01',
        type: 'tool_result',
        content: 'The file /repo/CHANGELOG.md has been updated successfully.',
      }],
    },
    parent_tool_use_id: null,
    session_id: '2c132fbf-247d-44ec-b3fd-a28efe9fd2f1',
    timestamp: DATE,
    tool_use_result: {
      filePath: '/repo/CHANGELOG.md',
      oldString: '## [Unreleased]',
      newString: '## [Unreleased]\n\n### Added',
      originalFile: ORIGINAL_FILE,
      structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 6, lines: ['-old', '+new'] }],
      userModified: false,
      replaceAll: false,
      ...overrides,
    },
  });
}

describe('claude-code tool_use_result sidecar (D1)', () => {
  it('reclaims the sidecar that holds the bulk of an Edit row', () => {
    const before = editRowWithSidecar();
    const after = tombstoneRawContent(before, 'claude-code', DATE);

    expect(after).not.toBeNull();
    // The sidecar is ~99% of this row; anything less than a big win means the
    // walker found the tool_result string and missed `tool_use_result` again.
    expect(after!.length).toBeLessThan(before.length / 10);
    // 'a thing' appears only in originalFile -- '### Added' also lives in the
    // short newString, which is under threshold and legitimately survives.
    expect(after).not.toContain('a thing');
  });

  it('keeps the small scalars so the tool card still names the file', () => {
    const after = JSON.parse(tombstoneRawContent(editRowWithSidecar(), 'claude-code', DATE)!);

    expect(after.tool_use_result.filePath).toBe('/repo/CHANGELOG.md');
    expect(after.tool_use_result.userModified).toBe(false);
    expect(after.tool_use_result.replaceAll).toBe(false);
    // Structure stays parseable -- a consumer reading the sidecar gets an
    // object, not a truncated string.
    expect(typeof after.tool_use_result).toBe('object');
  });

  it('leaves the short tool_result body alone -- only the sidecar was oversized', () => {
    const after = JSON.parse(tombstoneRawContent(editRowWithSidecar(), 'claude-code', DATE)!);
    expect(after.message.content[0].content)
      .toBe('The file /repo/CHANGELOG.md has been updated successfully.');
  });

  it('is idempotent over the sidecar', () => {
    const once = tombstoneRawContent(editRowWithSidecar(), 'claude-code', DATE)!;
    expect(tombstoneRawContent(once, 'claude-code', DATE)).toBeNull();
  });

  // P3: the 2026-08-19 run tombstoned message.content and left the sidecar
  // intact on ~2,000 of every 7,500 rows. Those rows still have work to do,
  // so idempotency has to be per-slot, not per-row.
  it('still reclaims a row an earlier pass half-processed', () => {
    const halfDone = JSON.parse(editRowWithSidecar());
    halfDone.message.content[0].content = '[Output discarded to reclaim disk — 21.9 KB, 2026-08-19]';
    const before = JSON.stringify(halfDone);

    const after = tombstoneRawContent(before, 'claude-code', DATE);

    expect(after).not.toBeNull();
    expect(after!.length).toBeLessThan(before.length / 10);
    // The earlier marker must not be stacked or rewritten.
    expect(after).toContain('2026-08-19');
  });

  // P2: the rendered Edit diff comes from the tool_use CALL on the assistant
  // chunk, never from this sidecar, so dropping oldString/newString here costs
  // the UI nothing. Guard the call side explicitly.
  it('never touches the assistant tool_use call that the diff renders from', () => {
    const call = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Edit',
          input: { file_path: '/repo/CHANGELOG.md', old_string: ORIGINAL_FILE, new_string: 'x' },
        }],
      },
    });
    expect(tombstoneRawContent(call, 'claude-code', DATE)).toBeNull();
  });
});

describe('codex shapes (D2)', () => {
  it('reclaims item.completed aggregated_output at the top level', () => {
    const row = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_4',
        type: 'command_execution',
        command: "/bin/zsh -lc 'gh run view 25708667714 --log-failed'",
        status: 'completed',
        exit_code: 0,
        aggregated_output: BIG_OUTPUT,
      },
    });

    const after = tombstoneRawContent(row, 'openai-codex', DATE);
    expect(after).not.toBeNull();

    const parsed = JSON.parse(after!);
    expect(isTombstoned(parsed.item.aggregated_output)).toBe(true);
    // Everything the tool card renders survives.
    expect(parsed.item.command).toBe("/bin/zsh -lc 'gh run view 25708667714 --log-failed'");
    expect(parsed.item.exit_code).toBe(0);
    expect(parsed.item.status).toBe('completed');
  });

  it('reclaims ACP session/update rawOutput stdout', () => {
    const row = JSON.stringify({
      type: 'session/update',
      sessionId: '019ed695-56cb-79c0-940b-0729e5e8f27e',
      update: {
        rawOutput: {
          call_id: 'call_0HjmS5ZCdDoV5A4nUELSuwcD',
          process_id: '76841',
          command: ['/bin/zsh', '-lc', 'nl -ba src/foo.ts'],
          cwd: '/repo',
          source: 'unified_exec_startup',
          stdout: BIG_OUTPUT,
        },
      },
    });

    const after = tombstoneRawContent(row, 'openai-codex-acp', DATE);
    expect(after).not.toBeNull();

    const parsed = JSON.parse(after!);
    expect(isTombstoned(parsed.update.rawOutput.stdout)).toBe(true);
    expect(parsed.update.rawOutput.call_id).toBe('call_0HjmS5ZCdDoV5A4nUELSuwcD');
    expect(parsed.update.rawOutput.command).toEqual(['/bin/zsh', '-lc', 'nl -ba src/foo.ts']);
  });

  it('still handles the app-server params.item shape it already knew', () => {
    const row = JSON.stringify({
      method: 'item/completed',
      params: { item: { id: 'exec-1', command: 'npm test', exitCode: 1, aggregatedOutput: BIG_OUTPUT } },
    });
    const parsed = JSON.parse(tombstoneRawContent(row, 'openai-codex', DATE)!);
    expect(isTombstoned(parsed.params.item.aggregatedOutput)).toBe(true);
    expect(parsed.params.item.exitCode).toBe(1);
  });
});

// P1 -- the single most dangerous rule in this pass. `nimbalyst_tool_result`
// carries the payload of Nimbalyst's own MCP tools, and for AskUserQuestion
// that payload is the USER'S ANSWERS: their own words, ~1 KB (comfortably over
// the 512-byte threshold), with no server copy anywhere.
//
// The row records `tool_use_id` and `result` but NOT the tool name -- the name
// lives on the separate `nimbalyst_tool_use` row -- so a per-row pure rewrite
// cannot tell an AskUserQuestion answer from a 16 KB database dump. Guessing
// from size or content would be destroying user data on a heuristic, which
// .claude/rules/destructive-data-paths.md forbids outright. So the rewriter
// declines the whole shape until a driver can supply the tool name.
describe('nimbalyst_tool_result is never tombstoned (P1)', () => {
  it('preserves AskUserQuestion answers verbatim', () => {
    const answers = JSON.stringify({
      answers: {
        'Should the mobile navigation show desktops as a top-level grouping?': 'Top-level grouping (Recommended)',
        'For encryption key sharing between desktop and mobile, which approach?': 'QR handoff',
      },
    });
    const row = JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: 'toolu_016LgqbUPXPPRn58kvbKenYo',
      result: answers,
    });

    expect(tombstoneRawContent(row, 'claude-code', DATE)).toBeNull();
  });

  it('declines even a large payload, because the row cannot name its tool', () => {
    const row = JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: 'toolu_02',
      result: BIG_OUTPUT,
    });
    expect(tombstoneRawContent(row, 'openai-codex', DATE)).toBeNull();
  });
});

describe('transcript projection after tombstoning', () => {
  it('still produces the same event shape, with a placeholder result', async () => {
    // The load-bearing assertion for Layer 2: run the REAL parser pipeline, not
    // a hand-built approximation. If a tombstone stopped parsing as a
    // tool_result, the tool card would vanish from the transcript entirely
    // rather than showing a discarded body.
    const original: RawMessage[] = [
      rawMessage({ id: 1, content: TOOL_CALL }),
      rawMessage({ id: 2, content: toolResultRow(BIG_OUTPUT) }),
    ];
    const tombstonedContent = tombstoneRawContent(
      toolResultRow(BIG_OUTPUT),
      'claude-code',
      DATE,
    )!;
    const tombstoned: RawMessage[] = [
      rawMessage({ id: 1, content: TOOL_CALL }),
      rawMessage({ id: 2, content: tombstonedContent }),
    ];

    const before = await rawMessagesToCanonicalEvents(original, 'claude-code');
    const after = await rawMessagesToCanonicalEvents(tombstoned, 'claude-code');

    expect(after.length).toBe(before.length);
    expect(after.map((e) => e.eventType)).toEqual(before.map((e) => e.eventType));

    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    expect(beforeJson).toContain('stdout line');
    expect(afterJson).not.toContain('stdout line');
    expect(afterJson).toContain('Output discarded to reclaim disk');
    // The tool name must survive so the card still says what ran.
    expect(afterJson).toContain('Bash');
  });
});
