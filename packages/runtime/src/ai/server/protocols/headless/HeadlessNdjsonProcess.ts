/**
 * Shared transport for CLI agents that run one process per turn and stream
 * newline-delimited JSON on stdout.
 *
 * This is deliberately *not* an ACP client. Grok Build and Cursor Agent were
 * both measured against their ACP surfaces and both report strictly more about
 * their file edits on this headless path — Cursor's `editToolCall` carries
 * `beforeFullFileContent`, and Grok's `tool_call_update` carries a
 * `{path, oldText, newText}` diff block. ACP has no authoritative file-change
 * item at all, which is why every ACP provider in this codebase is stuck on
 * watcher-inferred attribution. Reusing an ACP client here would have thrown
 * that data away for the sake of code reuse.
 *
 * What the two agents genuinely share is the plumbing below: spawn with the
 * enhanced PATH, split stdout on newlines, tolerate garbage lines, surface
 * stderr on a non-zero exit, and tear the process tree down on abort.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { terminateOwnedProcessTree } from '../processTreeTermination';
import { scrubProviderApiKeys } from '../../providerApiKeyScrub';

// Allow full-file edit records up to 32 MiB of UTF-8, but bound newline-free output.
const MAX_STDOUT_LINE_BYTES = 32 * 1024 * 1024;

export interface HeadlessNdjsonRunOptions {
  /** Executable to run. Resolved by the caller, never a bare name if avoidable. */
  command: string;
  args: string[];
  /** Working directory for the turn. */
  cwd: string;
  env?: Record<string, string>;
  /** Prompt written to stdin, when the CLI reads it there rather than from argv. */
  stdin?: string;
  abortSignal?: AbortSignal;
}

/** A line of stdout that did not parse as JSON, kept for diagnostics. */
export interface HeadlessNdjsonGarbage {
  kind: 'garbage';
  line: string;
}

export interface HeadlessNdjsonRecord {
  kind: 'record';
  value: Record<string, unknown>;
}

export type HeadlessNdjsonItem = HeadlessNdjsonRecord | HeadlessNdjsonGarbage;

export class HeadlessNdjsonExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    const detail = stderr.trim().split('\n').slice(-8).join('\n');
    super(
      `Agent process exited with code ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
      + (detail ? `:\n${detail}` : ''),
    );
    this.name = 'HeadlessNdjsonExitError';
  }
}

/**
 * Run a turn and yield each parsed stdout line as it arrives.
 *
 * Throws `HeadlessNdjsonExitError` on a non-zero exit so the caller can map the
 * CLI's own stderr into a provider-level error (not-installed, not-logged-in),
 * rather than swallowing it into an empty turn.
 */
export async function* runHeadlessNdjson(
  options: HeadlessNdjsonRunOptions,
): AsyncGenerator<HeadlessNdjsonItem> {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ? { ...options.env } : scrubProviderApiKeys({ ...process.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Bounded: a chatty CLI must not grow this without limit across a long turn.
    stderr = (stderr + chunk).slice(-64_000);
  });

  const onAbort = () => terminateOwnedProcessTree(child);
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
  // Overflow or early consumer exit can skip the await below; handle late errors.
  void exited.catch(() => {});

  try {
    let fragments: string[] = [];
    let pendingBytes = 0;
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf('\n', offset);
        const fragment = chunk.slice(offset, newlineIndex === -1 ? undefined : newlineIndex);
        pendingBytes += Buffer.byteLength(fragment, 'utf8');
        if (pendingBytes > MAX_STDOUT_LINE_BYTES) {
          throw new Error('Agent stdout line exceeded the 32 MiB limit. The agent process was terminated.');
        }
        fragments.push(fragment);
        if (newlineIndex === -1) break;
        const item = parseLine(fragments.join(''));
        fragments = [];
        pendingBytes = 0;
        if (item) yield item;
        offset = newlineIndex + 1;
      }
    }
    // A CLI that exits without a trailing newline still owes us its last event.
    const tail = parseLine(fragments.join(''));
    if (tail) yield tail;

    const { code, signal } = await exited;
    if (options.abortSignal?.aborted) return;
    if (code !== 0) {
      throw new HeadlessNdjsonExitError(code, signal, stderr);
    }
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    terminateOwnedProcessTree(child);
  }
}

function parseLine(line: string): HeadlessNdjsonItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { kind: 'record', value: value as Record<string, unknown> };
    }
    return { kind: 'garbage', line: trimmed };
  } catch {
    return { kind: 'garbage', line: trimmed };
  }
}
