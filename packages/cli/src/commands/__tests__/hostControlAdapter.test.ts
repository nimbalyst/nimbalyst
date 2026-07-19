import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import type { ParsedArgs } from '../../cli/parse.js';
import { ExitCode } from '../../cli/exitCodes.js';
import { runHostControlAdapter } from '../hostControlAdapter.js';

const args: ParsedArgs = {
  noun: 'host-control',
  positionals: [],
  flags: {},
};

const request = {
  version: 1,
  operation: 'watcher_obligation_event',
  sessionId: 'session-1',
  prompt: 'priority prompt',
  obligationId: 'obligation-1',
  eventKey: 'terminal_observed',
};

function input(value: unknown): Readable {
  return Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]);
}

function outputCapture() {
  const writes: string[] = [];
  return {
    writes,
    writeStdout: (value: string) => {
      writes.push(value);
    },
  };
}

function endpoint() {
  return { pid: 123, port: 4567, token: 'endpoint-token' };
}

describe('runHostControlAdapter', () => {
  it.each([
    ['missing', ''],
    ['malformed', '{not-json'],
    ['non-object', '[]'],
  ])('rejects %s stdin with one usage receipt', async (_name, stdinValue) => {
    const output = outputCapture();
    const fetchMock = vi.fn();

    const code = await runHostControlAdapter(args, {
      stdin: input(stdinValue),
      discoverEndpoint: endpoint,
      fetch: fetchMock,
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.USAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0]).accepted).toBe(false);
  });

  it('rejects capped stdin immediately with one bounded usage receipt', async () => {
    const output = outputCapture();
    const fetchMock = vi.fn();

    const code = await runHostControlAdapter(args, {
      stdin: Readable.from([Buffer.alloc(4097, 'x')]),
      discoverEndpoint: endpoint,
      fetch: fetchMock,
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.USAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual({
      accepted: false,
      outcome: 'input_too_large',
    });
  });

  it('returns CONNECTION when endpoint discovery fails without a fallback', async () => {
    const output = outputCapture();
    const fetchMock = vi.fn();

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: () => null,
      fetch: fetchMock,
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.CONNECTION);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual({
      accepted: false,
      outcome: 'endpoint_unavailable',
    });

    const source = readFileSync(
      resolve(process.cwd(), 'packages/cli/src/commands/hostControlAdapter.ts'),
      'utf8',
    );
    expect(source).not.toContain("from './common");
    expect(source).not.toContain('DirectGateway');
    expect(source).not.toContain('makeGateway');
  });

  it('posts to the exact authenticated endpoint and maps verified success to zero', async () => {
    const output = outputCapture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accepted: true,
      outcome: 'priority_delivery_verified',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: endpoint,
      fetch: fetchMock,
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.OK);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4567/host-control', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer endpoint-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual({
      accepted: true,
      outcome: 'priority_delivery_verified',
    });
  });

  it('maps a well-formed negative host receipt to REJECTED', async () => {
    const output = outputCapture();
    const negative = { accepted: false, outcome: 'delivery_unverified', action: 'interrupt_attempted' };

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: endpoint,
      fetch: async () => new Response(JSON.stringify(negative), { status: 409 }),
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.REJECTED);
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual(negative);
  });

  it('does not verify an accepted receipt with the wrong outcome', async () => {
    const output = outputCapture();
    const unexpected = { accepted: true, outcome: 'processing_triggered' };

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: endpoint,
      fetch: async () => new Response(JSON.stringify(unexpected), { status: 200 }),
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.REJECTED);
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual(unexpected);
  });

  it('redacts path and UUID runs from bounded diagnostic output', async () => {
    const output = outputCapture();
    const sensitive = 'D:\\private\\worktrees\\5c282c81-7855-4716-b3fe-8808c7ee80a2\\secret-file';

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: endpoint,
      fetch: async () => {
        throw new Error(`connect failed at ${sensitive}`);
      },
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.CONNECTION);
    expect(output.writes).toHaveLength(1);
    const receipt = JSON.parse(output.writes[0]);
    expect(receipt.accepted).toBe(false);
    expect(receipt.outcome).toBe('connection_failed');
    expect(receipt.diagnostic).toContain('...[redacted]');
    expect(receipt.diagnostic).not.toContain('5c282c81-7855-4716-b3fe-8808c7ee80a2');
    expect(receipt.diagnostic).not.toContain('secret-file');
  });

  it('emits one synthesized JSON object for a non-JSON response', async () => {
    const output = outputCapture();

    const code = await runHostControlAdapter(args, {
      stdin: input(request),
      discoverEndpoint: endpoint,
      fetch: async () => new Response('not-json', { status: 500 }),
      writeStdout: output.writeStdout,
    });

    expect(code).toBe(ExitCode.CONNECTION);
    expect(output.writes).toHaveLength(1);
    expect(JSON.parse(output.writes[0])).toEqual({
      accepted: false,
      outcome: 'malformed_response',
    });
  });
});
