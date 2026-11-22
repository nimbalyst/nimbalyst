// @vitest-environment node
/**
 * Module side of `ctx.services.terminals`: a handle must not lose output or an
 * exit that arrives before the module could subscribe.
 */
import { describe, expect, it } from 'vitest';
import { createBackendTerminalsClient } from '../backendTerminalsClient';

function harness() {
  const calls: Array<{ op: string; args: any }> = [];
  let output: (payload: unknown) => void = () => {};
  let exit: (payload: unknown) => void = () => {};
  let releaseCreate: ((value: unknown) => void) | null = null;
  const service = createBackendTerminalsClient({
    call: (op, args) => {
      calls.push({ op, args });
      if (op === 'create') return new Promise((resolve) => (releaseCreate = resolve));
      return Promise.resolve(op === 'read' ? { text: 'log', cursor: 3, truncated: false, gap: false } : {});
    },
    onOutput: (handler) => (output = handler),
    onExit: (handler) => (exit = handler),
  });
  return {
    service,
    calls,
    output: (terminalId: string, data: string, cursor: number) => output({ terminalId, data, cursor }),
    exit: (terminalId: string, exitCode: number) => exit({ terminalId, exitCode }),
    respond: (terminalId: string, pid = 100) => releaseCreate!({ terminalId, pid }),
  };
}

const options = { key: 'web', title: 'Web', command: 'pnpm run dev' };

describe('createBackendTerminalsClient', () => {
  it('replays output and exit that arrived before the create response to the first subscribers', async () => {
    const h = harness();
    const pending = h.service.createCommandTerminal(options);
    // The command fails fast: it prints and exits before create has returned.
    h.output('t1', 'sh: pnpm: command not found\r\n', 29);
    h.exit('t1', 127);
    h.respond('t1', 4242);
    const terminal = await pending;

    expect(terminal.id).toBe('t1');
    expect(terminal.pid).toBe(4242);
    const chunks: string[] = [];
    const exits: number[] = [];
    terminal.onOutput((chunk) => chunks.push(chunk.data));
    terminal.onExit((e) => exits.push(e.exitCode));
    expect(chunks).toEqual(['sh: pnpm: command not found\r\n']);
    expect(exits).toEqual([127]);
  });

  it('holds output until the first subscriber, then delivers live and stops after unsubscribe', async () => {
    const h = harness();
    const pending = h.service.createCommandTerminal(options);
    h.respond('t1');
    const terminal = await pending;
    h.output('t1', 'a', 1);

    const chunks: Array<{ data: string; cursor: number }> = [];
    const unsubscribe = terminal.onOutput((chunk) => chunks.push(chunk));
    h.output('t1', 'b', 2);
    unsubscribe();
    h.output('t1', 'c', 3);

    expect(chunks).toEqual([
      { data: 'a', cursor: 1 },
      { data: 'b', cursor: 2 },
    ]);
  });

  it('routes events to the terminal they belong to and ignores unknown terminals', async () => {
    const h = harness();
    const first = h.service.createCommandTerminal(options);
    h.respond('t1');
    const a = await first;
    const second = h.service.createCommandTerminal({ ...options, key: 'worker' });
    h.respond('t2');
    const b = await second;

    const seenA: string[] = [];
    const seenB: string[] = [];
    a.onOutput((c) => seenA.push(c.data));
    b.onOutput((c) => seenB.push(c.data));
    h.output('t2', 'for b', 5);
    h.output('someone-elses', 'stray', 5);
    expect(seenA).toEqual([]);
    expect(seenB).toEqual(['for b']);
  });

  it('sends each handle method as an op carrying its own terminal id', async () => {
    const h = harness();
    const pending = h.service.createCommandTerminal(options);
    h.respond('t1');
    const terminal = await pending;

    await terminal.kill('SIGINT');
    await terminal.stop({ graceMs: 1000 });
    expect(await terminal.read({ since: 12 })).toMatchObject({ text: 'log', cursor: 3 });
    await terminal.reveal();
    await terminal.setStatus('warning');
    await terminal.dispose();

    expect(h.calls.slice(1)).toEqual([
      { op: 'kill', args: { terminalId: 't1', signal: 'SIGINT' } },
      { op: 'stop', args: { terminalId: 't1', graceMs: 1000 } },
      { op: 'read', args: { terminalId: 't1', since: 12 } },
      { op: 'reveal', args: { terminalId: 't1' } },
      { op: 'setStatus', args: { terminalId: 't1', tone: 'warning' } },
      { op: 'dispose', args: { terminalId: 't1' } },
    ]);
  });
});
