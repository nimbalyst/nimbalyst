import type { Readable } from 'stream';
import type { ParsedArgs } from '../cli/parse.js';
import { ExitCode, type ExitCodeValue } from '../cli/exitCodes.js';
import { discoverEndpoint, type EndpointDescriptor } from '../gateway/endpoint.js';
import { redactPathsWithUuids } from '../utils/redactPathsWithUuids.js';

const MAX_JSON_BYTES = 4096;
const MAX_DIAGNOSTIC_CHARS = 500;

export interface HostControlAdapterDependencies {
  stdin?: Readable;
  discoverEndpoint?: () => EndpointDescriptor | null;
  fetch?: typeof fetch;
  writeStdout?: (value: string) => void;
}

class AdapterFailure extends Error {
  constructor(
    readonly exitCode: ExitCodeValue,
    readonly receipt: Record<string, unknown>,
  ) {
    super(String(receipt.outcome ?? 'adapter_error'));
  }
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactPathsWithUuids(message).slice(0, MAX_DIAGNOSTIC_CHARS);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readCappedInput(input: Readable): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > MAX_JSON_BYTES) {
        input.pause();
        input.destroy();
        throw new AdapterFailure(ExitCode.USAGE, {
          accepted: false,
          outcome: 'input_too_large',
        });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof AdapterFailure) throw error;
    throw new AdapterFailure(ExitCode.USAGE, {
      accepted: false,
      outcome: 'input_unreadable',
      diagnostic: boundedDiagnostic(error),
    });
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new AdapterFailure(ExitCode.USAGE, {
      accepted: false,
      outcome: 'missing_input',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdapterFailure(ExitCode.USAGE, {
      accepted: false,
      outcome: 'malformed_input',
    });
  }
  if (!isJsonObject(parsed)) {
    throw new AdapterFailure(ExitCode.USAGE, {
      accepted: false,
      outcome: 'invalid_input',
    });
  }
  return parsed;
}

async function readCappedResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new AdapterFailure(ExitCode.CONNECTION, {
      accepted: false,
      outcome: 'empty_response',
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new AdapterFailure(ExitCode.CONNECTION, {
          accepted: false,
          outcome: 'response_too_large',
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdapterFailure(ExitCode.CONNECTION, {
      accepted: false,
      outcome: 'malformed_response',
    });
  }
  if (
    !isJsonObject(parsed)
    || typeof parsed.accepted !== 'boolean'
    || typeof parsed.outcome !== 'string'
    || parsed.outcome.length === 0
  ) {
    throw new AdapterFailure(ExitCode.REJECTED, {
      accepted: false,
      outcome: 'unverified_response',
    });
  }
  return parsed;
}

/**
 * Native watcher-controller adapter. The optional dependencies are a test seam;
 * production always uses process stdin/stdout, endpoint discovery, and fetch.
 */
export async function runHostControlAdapter(
  _args: ParsedArgs,
  dependencies: HostControlAdapterDependencies = {},
): Promise<number> {
  const input = dependencies.stdin ?? process.stdin;
  const findEndpoint = dependencies.discoverEndpoint ?? discoverEndpoint;
  const fetchRequest = dependencies.fetch ?? fetch;
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));

  let receipt: Record<string, unknown>;
  let exitCode: ExitCodeValue;
  try {
    const request = await readCappedInput(input);
    const endpoint = findEndpoint();
    if (!endpoint) {
      throw new AdapterFailure(ExitCode.CONNECTION, {
        accepted: false,
        outcome: 'endpoint_unavailable',
      });
    }

    let response: Response;
    try {
      response = await fetchRequest(`http://127.0.0.1:${endpoint.port}/host-control`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new AdapterFailure(ExitCode.CONNECTION, {
        accepted: false,
        outcome: 'connection_failed',
        diagnostic: boundedDiagnostic(error),
      });
    }

    receipt = await readCappedResponse(response);
    exitCode = response.ok
      && receipt.accepted === true
      && receipt.outcome === 'priority_delivery_verified'
      ? ExitCode.OK
      : ExitCode.REJECTED;
  } catch (error) {
    if (error instanceof AdapterFailure) {
      receipt = error.receipt;
      exitCode = error.exitCode;
    } else {
      receipt = {
        accepted: false,
        outcome: 'adapter_error',
        diagnostic: boundedDiagnostic(error),
      };
      exitCode = ExitCode.CONNECTION;
    }
  }

  writeStdout(`${JSON.stringify(receipt)}\n`);
  return exitCode;
}
