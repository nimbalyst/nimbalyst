/**
 * Wire protocol of the on-device dictation helper
 * (native/dictation-helper/main.swift). One JSON object per line both ways.
 * Kept free of electron and child_process imports so it is unit-testable.
 */

export type HelperMessage =
  | { type: 'hello'; engine: string; version: number }
  | { type: 'preparing'; id: string }
  | { type: 'ready'; id: string }
  | { type: 'partial'; id: string; text: string }
  | { type: 'final'; id: string; text: string }
  | { type: 'error'; id?: string; code: string; message: string }
  | { type: 'ended'; id: string };

export type HelperCommand =
  | { type: 'start'; id: string; locale?: string; contextualStrings: string[] }
  | { type: 'audio'; id: string; data: string }
  | { type: 'stop'; id: string; cancel: boolean }
  | { type: 'shutdown' };

export function encodeHelperCommand(command: HelperCommand): string {
  return JSON.stringify(command) + '\n';
}

/** Parse one stdout line. Returns null for blank, malformed, or unknown lines. */
export function parseHelperLine(line: string): HelperMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : undefined;
  switch (obj.type) {
    case 'hello':
      return {
        type: 'hello',
        engine: typeof obj.engine === 'string' ? obj.engine : 'unknown',
        version: typeof obj.version === 'number' ? obj.version : 0,
      };
    case 'preparing':
    case 'ready':
    case 'ended':
      return id ? { type: obj.type, id } : null;
    case 'partial':
    case 'final':
      return id && typeof obj.text === 'string' ? { type: obj.type, id, text: obj.text } : null;
    case 'error':
      return {
        type: 'error',
        ...(id ? { id } : {}),
        code: typeof obj.code === 'string' ? obj.code : 'engine-error',
        message: typeof obj.message === 'string' ? obj.message : 'Dictation helper error',
      };
    default:
      return null;
  }
}

/**
 * Splits a byte stream into lines. Partial trailing data is held until the
 * next chunk; stdout chunk boundaries do not align with message boundaries.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      onLine(line);
      newline = pending.indexOf('\n');
    }
  };
}

const MAX_CONTEXT_STRINGS = 100;
const MAX_CONTEXT_STRING_LENGTH = 64;

/** Dedupe, trim, and cap the renderer-supplied vocabulary. */
export function capContextStrings(strings: unknown): string[] {
  if (!Array.isArray(strings)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of strings) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_CONTEXT_STRING_LENGTH || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_CONTEXT_STRINGS) break;
  }
  return out;
}
