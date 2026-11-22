/**
 * `.nimbalyst/run.json`: parsing, validation and edits. Pure: text in, text or
 * targets out. Reading, writing and watching the file is the caller's job.
 *
 * The file is committed with the project, so a teammate's hand edit can be
 * wrong in any way. Parsing never throws: a target that would not run is
 * skipped and named in `errors`, and the valid ones still load. Edits are the
 * opposite: they refuse to touch a file that does not parse, because rewriting
 * it would throw away whatever the person was in the middle of typing.
 */
import type { RunTarget } from '../shared/types';

export interface ParsedRunConfig {
  targets: RunTarget[];
  errors: string[];
  /** The file as a whole could not be read as a run config. */
  fatal: boolean;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_COMMAND_LENGTH = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A relative path that does not climb out of the project. */
function isInsideProject(cwd: string): boolean {
  if (cwd.startsWith('/') || cwd.startsWith('\\') || /^[a-zA-Z]:/.test(cwd)) return false;
  let depth = 0;
  for (const part of cwd.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    depth += part === '..' ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

/**
 * Validate one target. Returns the cleaned target (documented fields only), or
 * the reason it cannot be used.
 */
export function validateTarget(raw: unknown): { target: RunTarget } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'a target must be an object' };
  const { id, name, command, cwd, port, url, env, readyPattern } = raw;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return {
      error: `id ${JSON.stringify(id)} must be lowercase letters, digits, "-" or "_", starting with a letter or digit`,
    };
  }
  const label = `target "${id}"`;
  if (typeof name !== 'string' || name.trim() === '') return { error: `${label}: name is required` };
  if (typeof command !== 'string' || command.trim() === '') return { error: `${label}: command is required` };
  if (command.length > MAX_COMMAND_LENGTH) return { error: `${label}: command is too long` };

  const target: RunTarget = { id, name: name.trim(), command: command.trim() };

  if (cwd !== undefined) {
    if (typeof cwd !== 'string') return { error: `${label}: cwd must be a string` };
    if (!isInsideProject(cwd)) return { error: `${label}: cwd must be a relative path inside the project` };
    if (cwd.trim() !== '') target.cwd = cwd.trim();
  }
  if (port !== undefined) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `${label}: port must be a whole number from 1 to 65535` };
    }
    target.port = port;
  }
  if (url !== undefined) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { error: `${label}: url must start with http:// or https://` };
    }
    target.url = url;
  }
  if (env !== undefined) {
    if (!isPlainObject(env)) return { error: `${label}: env must be an object of strings` };
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') return { error: `${label}: env.${key} must be a string` };
      cleaned[key] = value;
    }
    if (Object.keys(cleaned).length > 0) target.env = cleaned;
  }
  if (readyPattern !== undefined) {
    if (typeof readyPattern !== 'string' || readyPattern === '') {
      return { error: `${label}: readyPattern must be a non-empty string` };
    }
    try {
      new RegExp(readyPattern);
    } catch {
      return { error: `${label}: readyPattern is not a valid regular expression` };
    }
    target.readyPattern = readyPattern;
  }
  return { target };
}

function parseRoot(text: string): { root: Record<string, unknown> } | { error: string } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return { error: `run.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(root) || !Array.isArray(root.targets)) {
    return { error: 'run.json must be an object with a "targets" array' };
  }
  return { root };
}

export function parseRunConfig(text: string): ParsedRunConfig {
  const parsed = parseRoot(text);
  if ('error' in parsed) return { targets: [], errors: [parsed.error], fatal: true };

  const targets: RunTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.root.targets as unknown[]) {
    const result = validateTarget(raw);
    if ('error' in result) {
      errors.push(result.error);
      continue;
    }
    if (seen.has(result.target.id)) {
      errors.push(`target "${result.target.id}" is defined more than once; only the first is used`);
      continue;
    }
    seen.add(result.target.id);
    targets.push(result.target);
  }
  return { targets, errors, fatal: false };
}

export function serializeRunConfig(root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** The parsed file to edit, or a fresh one when there is no file. Throws if the file cannot be parsed. */
function editableRoot(text: string | null): { root: Record<string, unknown>; targets: unknown[] } {
  if (text === null || text.trim() === '') return { root: { targets: [] }, targets: [] };
  const parsed = parseRoot(text);
  if ('error' in parsed) throw new Error(`${parsed.error}. Fix the file by hand before changing targets.`);
  return { root: parsed.root, targets: [...(parsed.root.targets as unknown[])] };
}

function idOf(raw: unknown): unknown {
  return isPlainObject(raw) ? raw.id : undefined;
}

/**
 * Add a target, or replace the one with the same id. `replaceId` replaces a
 * target under a different id (a rename). Returns the new file text.
 */
export function upsertTarget(text: string | null, target: RunTarget, replaceId?: string): string {
  const validated = validateTarget(target);
  if ('error' in validated) throw new Error(validated.error);
  const { root, targets } = editableRoot(text);

  const slotId = replaceId ?? validated.target.id;
  if (replaceId && replaceId !== validated.target.id && targets.some((t) => idOf(t) === validated.target.id)) {
    throw new Error(`A run target with id "${validated.target.id}" already exists`);
  }
  const index = targets.findIndex((t) => idOf(t) === slotId);
  if (replaceId && index < 0) throw new Error(`No run target with id "${replaceId}"`);
  if (index >= 0) targets[index] = validated.target;
  else targets.push(validated.target);
  return serializeRunConfig({ ...root, targets });
}

/** Remove a target by id. Returns the new file text. */
export function removeTarget(text: string | null, id: string): string {
  const { root, targets } = editableRoot(text);
  const remaining = targets.filter((t) => idOf(t) !== id);
  if (remaining.length === targets.length) throw new Error(`No run target with id "${id}"`);
  return serializeRunConfig({ ...root, targets: remaining });
}
