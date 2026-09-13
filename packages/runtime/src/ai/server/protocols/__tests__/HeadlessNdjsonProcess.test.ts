// @vitest-environment node
/**
 * Real `node -e` children exercise process plumbing; fake children let the
 * stdout limit tests control exact chunk sizes and observe termination.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, PassThrough } from 'stream';
import { spawn } from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
import {
  runHeadlessNdjson,
  HeadlessNdjsonExitError,
  type HeadlessNdjsonItem,
} from '../headless/HeadlessNdjsonProcess';

async function collect(script: string, abortSignal?: AbortSignal): Promise<HeadlessNdjsonItem[]> {
  const items: HeadlessNdjsonItem[] = [];
  for await (const item of runHeadlessNdjson({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    abortSignal,
  })) {
    items.push(item);
  }
  return items;
}

function fakeChild(chunks: Iterable<string>) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Readable.from(chunks),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; }),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  child.stdout.on('end', () => child.emit('close', 0, null));
  return child;
}

describe('runHeadlessNdjson', () => {
  it('handles a late child error after stdout overflow without an unhandled rejection', async () => {
    const child = fakeChild(['x'.repeat(32 * 1024 * 1024 + 1)]);
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })));
      return true;
    });
    await expect(collect('')).rejects.toThrow(/32 MiB/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('scrubs the inherited environment at the spawn boundary', async () => {
    vi.stubEnv('CURSOR_API_KEY', 'synthetic-key');
    try {
      fakeChild([]);
      await collect('');
      const env = vi.mocked(spawn).mock.lastCall![2]!.env!;
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(env.HOME).toBe(process.env.HOME);
      expect(process.env.CURSOR_API_KEY).toBe('synthetic-key');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([['x', ''], ['x', '\n'], ['é', '']])('kills a child whose pending stdout line exceeds 32 MiB (%j, suffix %j)', async (character, suffix) => {
    const child = fakeChild((function* () {
      const chunk = character.repeat(1024 * 1024 / Buffer.byteLength(character));
      for (let i = 0; i < 32; i++) yield chunk;
      yield character + suffix;
    })());
    // Drop the output on success so a regression does not print 32 MiB in the diff.
    await expect(collect('').then(() => undefined)).rejects.toThrow(/stdout.*32 MiB/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('accepts a full-file record at 32 MiB and resets the limit at each newline', async () => {
    const prefix = '{"content":"';
    const suffix = '"}';
    const content = 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(prefix + suffix));
    // The chunk is larger than the limit, but neither individual record is.
    fakeChild([prefix + content + suffix + '\n{"type":"next"}\n']);
    const items = await collect('');
    expect(items).toHaveLength(2);
    expect(items[0].kind === 'record' && items[0].value.content === content).toBe(true);
    expect(items[1]).toEqual({ kind: 'record', value: { type: 'next' } });
  });

  it('reassembles records split across chunk boundaries', async () => {
    // Both CLIs emit long lines (a whole-file diff), so a record reliably
    // straddles more than one stdout chunk.
    const script = `
      process.stdout.write('{"type":"a"}\\n{"ty');
      setTimeout(() => process.stdout.write('pe":"b"}\\n{"type":"c"}\\n'), 10);
    `;
    const items = await collect(script);
    expect(items.map((i) => (i.kind === 'record' ? i.value.type : i.line)))
      .toEqual(['a', 'b', 'c']);
  });

  it('yields the last record when the process exits without a trailing newline', async () => {
    const items = await collect(`process.stdout.write('{"type":"only"}')`);
    expect(items).toEqual([{ kind: 'record', value: { type: 'only' } }]);
  });

  it('reports non-JSON lines as garbage instead of aborting the turn', async () => {
    // A CLI that prints a banner or a warning to stdout must not kill the run.
    const script = `process.stdout.write('warning: something\\n{"type":"a"}\\n[1,2]\\n')`;
    const items = await collect(script);
    expect(items).toEqual([
      { kind: 'garbage', line: 'warning: something' },
      { kind: 'record', value: { type: 'a' } },
      { kind: 'garbage', line: '[1,2]' },
    ]);
  });

  it('throws with the tail of stderr on a non-zero exit', async () => {
    // This is what turns an opaque empty turn into "you are not logged in".
    const script = `
      process.stderr.write('Not logged in\\n');
      process.exit(3);
    `;
    await expect(collect(script)).rejects.toThrow(HeadlessNdjsonExitError);
    await expect(collect(script)).rejects.toThrow(/code 3[\s\S]*Not logged in/);
  });

  it('stops cleanly when aborted mid-stream, without a spurious exit error', async () => {
    const controller = new AbortController();
    const script = `
      process.stdout.write('{"type":"a"}\\n');
      setInterval(() => {}, 1000);
    `;
    const items: HeadlessNdjsonItem[] = [];
    for await (const item of runHeadlessNdjson({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      abortSignal: controller.signal,
    })) {
      items.push(item);
      controller.abort();
    }
    // A killed process exits non-zero; a user-requested cancel is not an error.
    expect(items).toEqual([{ kind: 'record', value: { type: 'a' } }]);
  });
});
