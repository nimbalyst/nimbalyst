import { describe, expect, it, vi } from 'vitest';
import { AntigravityToolLoopProtocol } from '../ToolLoopProtocol';
import type { AntigravityServerManager } from '../ServerManager';

// These drive the REAL run() loop with a mock server.getModelResponse so no
// language server is spawned. They cover the convergence hardening added after
// the live run flailed (28 tool calls for a small task): the per-turn progress
// ledger surfaced back to the model, and the force-synthesis finalization that
// replaces the useless "[Agent reached tool-call iteration limit]" stub.

type Ev =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'complete' };

function makeProto(getModelResponse: (p: string) => Promise<string>, maxIterations: number) {
  const server = { getModelResponse: vi.fn(getModelResponse) } as unknown as AntigravityServerManager;
  const proto = new AntigravityToolLoopProtocol({ modelKey: 'MODEL_X', maxIterations, server });
  return { proto, spy: server.getModelResponse as unknown as ReturnType<typeof vi.fn> };
}

const LIST_TOOL = [{ type: 'function' as const, function: { name: 'list_files' } }];

async function drain(gen: AsyncGenerator<unknown>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const ev of gen) out.push(ev as Ev);
  return out;
}

describe('AntigravityToolLoopProtocol convergence hardening', () => {
  it('surfaces a progress ledger of prior tool calls in the next prompt', async () => {
    const prompts: string[] = [];
    let call = 0;
    const { proto, spy } = makeProto(async (p) => {
      prompts.push(p);
      call++;
      // 1st turn: request a tool. 2nd turn: finish with text.
      return call === 1 ? '{"tool_call":{"name":"list_files","arguments":{"path":"src"}}}' : 'done';
    }, 40);

    await drain(proto.run('look around', 'sys', LIST_TOOL, async () => 'a-listing'));

    expect(spy).toHaveBeenCalledTimes(2);
    // The 2nd prompt (after the tool ran) must show the progress ledger so the
    // model can see it already listed "src" and not repeat it.
    const second = prompts[1];
    expect(second).toContain('[Progress:');
    expect(second).toContain('list_files src');
  });

  it('force-synthesizes a real answer at the iteration cap instead of the stub', async () => {
    let call = 0;
    const { proto, spy } = makeProto(async () => {
      call++;
      // Always request a tool during the loop so it never converges on its own;
      // the finalization call (after the cap) returns text.
      return call <= 2
        ? '{"tool_call":{"name":"list_files","arguments":{"path":"."}}}'
        : 'Final synthesized answer from gathered context.';
    }, 2);

    const events = await drain(proto.run('task', 'sys', LIST_TOOL, async () => 'x'));

    // 2 loop iterations + 1 finalization call.
    expect(spy).toHaveBeenCalledTimes(3);
    const text = events.find((e) => e.type === 'text') as Extract<Ev, { type: 'text' }>;
    expect(text?.content).toBe('Final synthesized answer from gathered context.');
    expect(events.some((e) => e.type === 'text' && /iteration limit/.test(e.content))).toBe(false);
    expect(events[events.length - 1].type).toBe('complete');
  });

  it('force-synthesis instructs grounding and permits abstention, not a forced confident guess', async () => {
    // A weak model forced to "write your complete final answer now" fabricates a
    // confident answer when it lacks grounding. The finalize prompt must instead
    // require using only what was gathered and allow saying what is undetermined.
    const prompts: string[] = [];
    let call = 0;
    const { proto } = makeProto(async (p) => {
      prompts.push(p);
      call++;
      return call <= 2
        ? '{"tool_call":{"name":"list_files","arguments":{"path":"."}}}'
        : 'grounded answer';
    }, 2);

    await drain(proto.run('task', 'sys', LIST_TOOL, async () => 'x'));

    const finalPrompt = prompts[prompts.length - 1];
    expect(finalPrompt).toContain('ONLY the information actually gathered');
    expect(finalPrompt).toContain('remains undetermined');
    expect(finalPrompt).not.toContain('Write your complete final answer now');
  });

  it('falls back to the limit stub if the finalization call fails', async () => {
    let call = 0;
    const { proto } = makeProto(async () => {
      call++;
      if (call <= 1) return '{"tool_call":{"name":"list_files","arguments":{}}}';
      throw new Error('Antigravity GetModelResponse timed out');
    }, 1);

    const events = await drain(proto.run('task', 'sys', LIST_TOOL, async () => 'x'));

    const text = events.find((e) => e.type === 'text') as Extract<Ev, { type: 'text' }>;
    expect(text?.content).toBe('[Agent reached tool-call iteration limit]');
    expect(events[events.length - 1].type).toBe('complete');
  });

  it('stores only the compact tool-call envelope in history, not hallucinated thinking text', async () => {
    // The model wraps a real tool call in 40KB of hallucinated transcript. The
    // loop must persist ONLY the compact canonical envelope, or that 40KB lands
    // in history and explodes the re-rendered prompt every subsequent turn.
    const HALLUCINATION = 'X'.repeat(40_000);
    const prompts: string[] = [];
    let call = 0;
    const { proto } = makeProto(async (p) => {
      prompts.push(p);
      call++;
      return call === 1
        ? `${HALLUCINATION}\n{"tool_call":{"name":"list_files","arguments":{"path":"src"}}}\n${HALLUCINATION}`
        : 'done';
    }, 40);

    await drain(proto.run('go', 'sys', LIST_TOOL, async () => 'a-listing'));

    const second = prompts[1];
    expect(second).not.toContain('X'.repeat(1000)); // hallucination not persisted
    expect(second).toContain('"tool_call":{"name":"list_files"'); // canonical form is
  });

  it('bounds total prompt size by omitting the oldest tool outputs over budget', async () => {
    const BIG = 'Y'.repeat(20_000); // each result ~20KB, under the 24KB per-result cap
    const prompts: string[] = [];
    let call = 0;
    const { proto } = makeProto(async (p) => {
      prompts.push(p);
      call++;
      return call <= 3
        ? `{"tool_call":{"name":"list_files","arguments":{"path":"p${call}"}}}`
        : 'final';
    }, 40);

    await drain(proto.run('go', 'sys', LIST_TOOL, async () => BIG));

    // By the final render, three 20KB results (60KB) exceed the 28KB budget, so
    // the oldest are omitted rather than growing the prompt unbounded.
    const last = prompts[prompts.length - 1];
    expect(last).toContain('earlier output omitted to keep context small');
  });

  it('strips fabricated transcript continuation and special tokens from the final answer', async () => {
    const { proto } = makeProto(
      async () =>
        'Here is the real answer.<|im_end|>\nUser: a fabricated next question\nAssistant: fabricated reply',
      40,
    );

    const events = await drain(proto.run('go', 'sys', LIST_TOOL, async () => 'x'));

    const text = events.find((e) => e.type === 'text') as Extract<Ev, { type: 'text' }>;
    expect(text?.content).toBe('Here is the real answer.');
  });

  it('dedups identical read-only calls and force-synthesizes when stuck looping', async () => {
    const READ_TOOL = [{ type: 'function' as const, function: { name: 'read_file' } }];
    const { proto } = makeProto(async (p) => {
      if (/final answer now/i.test(p)) return 'SYNTHESIZED from gathered context.';
      return '{"tool_call":{"name":"read_file","arguments":{"path":"a.md"}}}';
    }, 40);
    const exec = vi.fn(async () => 'file contents');

    const events = await drain(proto.run('go', 'sys', READ_TOOL, exec));

    expect(exec).toHaveBeenCalledTimes(1);
    const text = events.find((e) => e.type === 'text') as Extract<Ev, { type: 'text' }>;
    expect(text?.content).toBe('SYNTHESIZED from gathered context.');
  });

  it('retries a malformed tool_call JSON instead of dropping the deliverable', async () => {
    const WRITE_TOOL = [{ type: 'function' as const, function: { name: 'write_file' } }];
    let call = 0;
    const { proto, spy } = makeProto(async () => {
      call++;
      // 1st: invalid JSON (literal newline inside the content string value).
      if (call === 1)
        return ('{"tool_call":{"name":"write_file","arguments":{"path":"r.md","content":"line1' +
          String.fromCharCode(10) +
          'line2"}}}');
      // 2nd: valid JSON after the retry nudge.
      if (call === 2)
        return '{"tool_call":{"name":"write_file","arguments":{"path":"r.md","content":"ok"}}}';
      return 'done';
    }, 40);
    const exec = vi.fn(async () => 'written');

    const events = await drain(proto.run('write a report', 'sys', WRITE_TOOL, exec));

    // The malformed call is retried (not dropped); the valid call then executes.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(events[events.length - 1].type).toBe('complete');
  });

  it('re-allows a read after a write_file mutates state (epoch bump)', async () => {
    const RW_TOOLS = [
      { type: 'function' as const, function: { name: 'read_file' } },
      { type: 'function' as const, function: { name: 'write_file' } },
    ];
    let n = 0;
    const { proto } = makeProto(async () => {
      n++;
      if (n === 1) return '{"tool_call":{"name":"read_file","arguments":{"path":"a.md"}}}';
      if (n === 2) return '{"tool_call":{"name":"write_file","arguments":{"path":"a.md","content":"x"}}}';
      if (n === 3) return '{"tool_call":{"name":"read_file","arguments":{"path":"a.md"}}}';
      return 'done';
    }, 40);
    const exec = vi.fn(async () => 'ok');

    await drain(proto.run('go', 'sys', RW_TOOLS, exec));

    expect(exec).toHaveBeenCalledTimes(3);
  });
});
