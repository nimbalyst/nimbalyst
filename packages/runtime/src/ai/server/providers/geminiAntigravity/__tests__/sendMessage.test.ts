// @vitest-environment node
/**
 * OBSERVED integration test for the GeminiAntigravityProvider stream.
 *
 * Drives the REAL provider.sendMessage() and the REAL
 * AntigravityToolLoopProtocol.run() tool loop. The ONLY mocked boundary is
 * AntigravityServerManager.prototype.getModelResponse: mocking it means the
 * language_server spawn, the ~/.gemini OAuth check, and the HTTPS Connect-RPC
 * never run, while every line of the provider's event-shaping executes for
 * real.
 *
 * Moved from packages/extensions/gemini-antigravity when the provider became
 * built-in. The cases are the same, re-pointed from the extension's
 * `activate(ctx).methods` lifecycle at the provider's `sendMessage`, and the
 * two-channel `toolExecutor` / `devToolExecutor` split is now one injected
 * executor (the host decides which permission gate a name routes through).
 *
 * Run from repo root:
 *   npx vitest --run packages/runtime/src/ai/server/providers/geminiAntigravity/__tests__/sendMessage.test.ts
 */
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiAntigravityProvider,
  type GeminiToolExecutorArgs,
} from '../../GeminiAntigravityProvider';
import { AntigravityServerManager } from '../AntigravityServerManager';
import type { StreamChunk } from '../../../types';

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('GeminiAntigravityProvider.sendMessage', () => {
  // vi.MockInstance with the explicit method signature. The unparameterized
  // `ReturnType<typeof vi.spyOn>` widens to a no-arg fallback under vitest's
  // overload set, which breaks assignability against the real 4-arg
  // AntigravityServerManager.getModelResponse signature.
  let getModelResponse: import('vitest').MockInstance<
    AntigravityServerManager['getModelResponse']
  >;
  let executor: ReturnType<typeof vi.fn>;
  let provider: GeminiAntigravityProvider;

  beforeEach(async () => {
    // Intercept the single server touch point inside run(). ensureRunning()
    // (and thus spawnStandalone) is never reached because we replace the method
    // that would call it.
    getModelResponse = vi.spyOn(AntigravityServerManager.prototype, 'getModelResponse');
    executor = vi.fn(async (_args: GeminiToolExecutorArgs) => ({ text: 'tool ok' }));
    GeminiAntigravityProvider.setToolExecutor(executor as never);
    provider = new GeminiAntigravityProvider();
    await provider.initialize({ model: 'gemini-3.8-flash-tiered' });
  });

  afterEach(() => {
    GeminiAntigravityProvider.setToolExecutor(null);
    provider.destroy();
    vi.restoreAllMocks(); // remove the prototype spy; the shared() singleton survives across tests
  });

  it('yields text then complete for a no-tool turn', async () => {
    getModelResponse.mockResolvedValue('Hello from the model.');

    const chunks = await collect(provider.sendMessage('hi', undefined, 's1'));

    const text = chunks.find((c) => c.type === 'text');
    expect(text?.content).toBe('Hello from the model.');

    const last = chunks[chunks.length - 1];
    expect(last.type).toBe('complete');
    expect(last.isComplete).toBe(true);
    expect(last.content).toBe('Hello from the model.');

    // Model called exactly once -> single no-tool round -> no spawn occurred.
    expect(getModelResponse).toHaveBeenCalledTimes(1);
    expect(executor).not.toHaveBeenCalled();
  });

  it('surfaces a missing explicit selection without contacting a replacement model', async () => {
    await provider.initialize({});
    const chunks = await collect(provider.sendMessage('hi', undefined, 'missing-selection'));
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('Select a Gemini model') }]);
    expect(getModelResponse).not.toHaveBeenCalled();
  });

  it('yields a tool_call with its result before text+complete when the model requests a tool', async () => {
    getModelResponse
      .mockResolvedValueOnce('{"tool_call":{"name":"echo","arguments":{"x":1}}}')
      .mockResolvedValueOnce('done');
    executor.mockResolvedValue({ text: 'echoed-1' });

    const chunks = await collect(
      provider.sendMessage('use the tool', undefined, 's2', undefined, undefined, undefined, [
        { type: 'function', function: { name: 'echo' } },
      ]),
    );

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's2', name: 'echo', args: { x: 1 } }),
    );

    const withResult = chunks.find(
      (c) => c.type === 'tool_call' && c.toolCall?.result !== undefined,
    );
    expect(withResult?.toolCall?.name).toBe('echo');
    expect(withResult?.toolCall?.arguments).toEqual({ x: 1 });
    expect(withResult?.toolCall?.result).toBe('echoed-1');
    // The announce chunk and the result chunk share one id, which is what file
    // attribution and pre-edit history tags correlate on.
    const announce = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.result === undefined);
    expect(announce?.toolCall?.id).toBe(withResult?.toolCall?.id);

    expect(chunks.find((c) => c.type === 'text')?.content).toBe('done');
    expect(chunks[chunks.length - 1].type).toBe('complete');
    expect(getModelResponse).toHaveBeenCalledTimes(2);
  });

  it('actually executes a run_command tool call in the workspace and returns its output', async () => {
    // run_command runs in this process (real child_process), NOT through the
    // injected executor - so this asserts genuine execution end-to-end through
    // the real tool loop. echo is a no-quote cross-platform marker (cmd + sh).
    const cmd = 'echo GEMINI_OK_5';
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'run_command', arguments: { command: cmd } } }),
      )
      .mockResolvedValueOnce('done');

    const chunks = await collect(
      provider.sendMessage('run it', undefined, 'rc1', undefined, os.tmpdir(), undefined, [
        { type: 'function', function: { name: 'run_command' } },
      ]),
    );

    const toolChunk = chunks.find(
      (c) => c.type === 'tool_call' && c.toolCall?.name === 'run_command' && c.toolCall?.result !== undefined,
    );
    expect(String(toolChunk?.toolCall?.result)).toContain('GEMINI_OK_5');
    expect(String(toolChunk?.toolCall?.result)).toContain('exit code: 0');
    expect(executor).not.toHaveBeenCalled();
  });

  it('routes a write_file tool call to the injected host executor', async () => {
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          tool_call: { name: 'write_file', arguments: { path: 'note.md', content: 'hello' } },
        }),
      )
      .mockResolvedValueOnce('saved');
    executor.mockResolvedValue({ text: 'Wrote note.md (5 bytes, 1 line(s)).' });

    await collect(
      provider.sendMessage('write it', undefined, 'wf1', undefined, os.tmpdir(), undefined, [
        { type: 'function', function: { name: 'write_file' } },
      ]),
    );

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'write_file',
        args: { path: 'note.md', content: 'hello' },
        workspacePath: os.tmpdir(),
      }),
    );
  });

  it('nudges and recovers when the model narrates a tool call instead of emitting it', async () => {
    // 1st round: prose intent, NO envelope (the stall failure mode). 2nd round:
    // real tool call. 3rd: final text. Without the nudge the loop would end
    // after round 1 and the tool would never run.
    getModelResponse
      .mockResolvedValueOnce("Now I'll read the file. Let's use read_file on package.json.")
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'read_file', arguments: { path: 'package.json' } } }),
      )
      .mockResolvedValueOnce('done');
    executor.mockResolvedValue({ text: 'file contents here' });

    const chunks = await collect(
      provider.sendMessage('read it', undefined, 'nudge1', undefined, os.tmpdir(), undefined, [
        { type: 'function', function: { name: 'read_file' } },
      ]),
    );

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', args: { path: 'package.json' } }),
    );
    expect(getModelResponse).toHaveBeenCalledTimes(3);
    expect(chunks[chunks.length - 1].content).toBe('done');
  });

  it('seeds prior-turn history so a later turn sees earlier context in the model prompt', async () => {
    getModelResponse.mockResolvedValueOnce('final answer');

    await collect(
      provider.sendMessage('what did we decide?', undefined, 'hist1', [
        { role: 'user', content: 'EARLIER_USER_MARKER', timestamp: 1 },
        { role: 'assistant', content: 'EARLIER_ASSISTANT_MARKER', timestamp: 2 },
      ]),
    );

    expect(getModelResponse).toHaveBeenCalledTimes(1);
    const prompt = String(getModelResponse.mock.calls[0][0]);
    expect(prompt).toContain('EARLIER_USER_MARKER');
    expect(prompt).toContain('EARLIER_ASSISTANT_MARKER');
    expect(prompt).toContain('what did we decide?');
  });

  it('refuses a tool the host did not grant (hard read-only segregation gate)', async () => {
    // Session granted ONLY read_file. If the model emits run_command anyway,
    // the tool loop must refuse it (not execute), so a restricted analyze child
    // physically cannot run a build even if Flash hallucinates the tool.
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'run_command', arguments: { command: 'echo SHOULD_NOT_RUN' } } }),
      )
      .mockResolvedValueOnce('done');

    const chunks = await collect(
      provider.sendMessage('try to run', undefined, 'gate1', undefined, os.tmpdir(), undefined, [
        { type: 'function', function: { name: 'read_file' } },
      ]),
    );

    const toolChunk = chunks.find(
      (c) => c.type === 'tool_call' && c.toolCall?.name === 'run_command' && c.toolCall?.result !== undefined,
    );
    expect(String(toolChunk?.toolCall?.result)).toMatch(/not available in this session/i);
    expect(String(toolChunk?.toolCall?.result)).not.toContain('SHOULD_NOT_RUN');
  });

  it('caps an oversized tool result in the model prompt but surfaces the full result to the host', async () => {
    // The huge tool output must be truncated in the prompt fed to round 2; an
    // uncapped history grows the single-shot prompt until GetModelResponse hangs.
    const HUGE = 'X'.repeat(50_000);
    getModelResponse
      .mockResolvedValueOnce('{"tool_call":{"name":"echo","arguments":{"x":1}}}')
      .mockResolvedValueOnce('done');
    executor.mockResolvedValue({ text: HUGE });

    const chunks = await collect(
      provider.sendMessage('use the tool', undefined, 'cap1', undefined, undefined, undefined, [
        { type: 'function', function: { name: 'echo' } },
      ]),
    );

    // The host (UI) receives the FULL, uncapped tool result.
    const toolChunk = chunks.find(
      (c) => c.type === 'tool_call' && c.toolCall?.name === 'echo' && c.toolCall?.result !== undefined,
    );
    expect(String(toolChunk?.toolCall?.result).length).toBe(50_000);

    expect(getModelResponse).toHaveBeenCalledTimes(2);
    const secondPrompt = String(getModelResponse.mock.calls[1][0]);
    expect(secondPrompt).toContain('OUTPUT TRUNCATED');
    expect(secondPrompt).not.toContain('X'.repeat(30_000));
  });
});
