// @vitest-environment node
/**
 * The registry's contract is coverage: if a payload location exists in a real
 * provider chunk, there is a slot for it. The bug this module was extracted to
 * kill (NIM-3661) was three passes each holding their own partial idea of the
 * shape, so the drift guard at the bottom matters more than any single
 * assertion here.
 */
import { describe, it, expect } from 'vitest';
import { providerPayloadSlots } from '../providerPayloadSlots';
import { slimClaudeCodeChunkForStorage } from '../../ai/server/providers/claudeCode/toolChunkUtils';

const paths = (chunk: unknown, source: string) =>
  providerPayloadSlots(chunk, source).map((s) => s.path);

describe('providerPayloadSlots -- claude-code', () => {
  it('finds the tool_use_result sidecar the retention pass used to walk past', () => {
    const chunk = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      tool_use_result: { filePath: '/a/b.ts', originalFile: 'z'.repeat(4000) },
    };

    expect(paths(chunk, 'claude-code')).toEqual(expect.arrayContaining([
      'message.content[0].content',
      'tool_use_result.filePath',
      'tool_use_result.originalFile',
    ]));
  });

  it('offers an image block as its own kind of slot, so policy stays with the caller', () => {
    const chunk = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: [
            { type: 'text', text: 'log output' },
            { type: 'image', source: { type: 'base64', data: 'A'.repeat(500) } },
          ],
        }],
      },
    };

    const slots = providerPayloadSlots(chunk, 'claude-code');
    expect(slots.map((s) => [s.path, s.kind])).toEqual([
      ['message.content[0].content[0].text', 'claudeToolResult'],
      ['message.content[0].content[1]', 'toolResultImage'],
    ]);
  });

  it('offers no slots on a tool_use call, whatever it carries', () => {
    const chunk = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'x'.repeat(9000) } }] },
    };
    expect(paths(chunk, 'claude-code')).toEqual([]);
  });
});

describe('providerPayloadSlots -- codex', () => {
  it('finds the item under BOTH the SDK and app-server paths', () => {
    const sdkEvent = { type: 'item.completed', item: { command: 'ls', aggregated_output: 'x' } };
    const appServer = { method: 'item/completed', params: { item: { aggregatedOutput: 'x' } } };

    expect(paths(sdkEvent, 'openai-codex')).toContain('item.aggregated_output');
    expect(paths(appServer, 'openai-codex')).toContain('params.item.aggregatedOutput');
  });

  it('finds ACP rawOutput but leaves the forensics beside it alone', () => {
    const chunk = {
      type: 'session/update',
      update: {
        rawOutput: {
          call_id: 'call_1',
          command: ['/bin/zsh', '-lc', 'ls'],
          cwd: '/repo',
          stdout: 'x'.repeat(4000),
        },
      },
    };

    const found = paths(chunk, 'openai-codex-acp');
    expect(found).toContain('update.rawOutput.stdout');
    // `command`, `cwd` and `call_id` are what the tool card renders. A broad
    // walk here would collapse them; the ACP walk is deliberately surgical.
    expect(found).toEqual(['update.rawOutput.stdout']);
  });

  it('walks a structured MCP result broadly', () => {
    const chunk = { type: 'item.completed', item: { result: { rows: 'x'.repeat(4000), elapsed: 12 } } };
    expect(paths(chunk, 'openai-codex')).toEqual(expect.arrayContaining([
      'item.result.rows',
      'item.result.elapsed',
    ]));
  });
});

describe('providerPayloadSlots -- Nimbalyst envelope', () => {
  it('surfaces nimbalyst_tool_result so a policy can decline it explicitly', () => {
    // The registry reports the slot; declining is the retention pass's call,
    // because this payload may be the user's own AskUserQuestion answers.
    const chunk = { type: 'nimbalyst_tool_result', tool_use_id: 't', result: '{"answers":{}}' };
    const slots = providerPayloadSlots(chunk, 'claude-code');

    expect(slots.map((s) => s.path)).toEqual(['result']);
    expect(slots[0].kind).toBe('nimbalystToolResult');
  });

  it('offers no slot on a nimbalyst_tool_use call', () => {
    const chunk = { type: 'nimbalyst_tool_use', id: 't', name: 'AskUserQuestion', input: { questions: [] } };
    expect(paths(chunk, 'claude-code')).toEqual([]);
  });
});

describe('slots write through to the chunk', () => {
  it('set() replaces the value in place', () => {
    const chunk = { type: 'user', tool_use_result: { originalFile: 'big' } };
    const slot = providerPayloadSlots(chunk, 'claude-code')[0];

    expect(slot.value).toBe('big');
    slot.set('small');
    expect(chunk.tool_use_result.originalFile).toBe('small');
    expect(slot.value).toBe('small');
  });
});

describe('drift guard', () => {
  // The whole point of the registry. `slimClaudeCodeChunkForStorage` still owns
  // its own policy (it DROPS keys where retention tombstones them), but the two
  // must agree on WHERE the payloads are. If someone teaches the slimmer about
  // a new field and not the registry, the retention pass silently goes blind to
  // it again -- which is exactly how 71% of the table became invisible.
  it('covers every claude-code field the write-time slimmer drops', () => {
    const chunk = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'The file was updated' },
          { type: 'thinking', thinking: 'reasoning', signature: 'A'.repeat(12_000) },
        ],
      },
      tool_use_result: {
        filePath: '/a/b/File.tsx',
        userModified: false,
        oldString: 'x'.repeat(5000),
        newString: 'y'.repeat(5000),
        originalFile: 'z'.repeat(20_000),
        structuredPatch: Array.from({ length: 100 }, (_, i) => ({ line: i })),
      },
    };

    const slim = slimClaudeCodeChunkForStorage(chunk) as typeof chunk;
    const dropped = Object.keys(chunk.tool_use_result)
      .filter((k) => !(k in slim.tool_use_result));
    expect(dropped.length).toBeGreaterThan(0);

    const found = paths(chunk, 'claude-code');
    for (const key of dropped) {
      expect(found).toContain(`tool_use_result.${key}`);
    }
    // The slimmer also strips thinking signatures; the registry must see those.
    expect(found).toContain('message.content[1].signature');
  });
});
