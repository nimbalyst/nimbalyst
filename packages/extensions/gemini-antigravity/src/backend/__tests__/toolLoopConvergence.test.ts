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
});
