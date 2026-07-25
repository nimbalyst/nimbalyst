/**
 * Minimal, dependency-free argv parser for the `nim <noun> <verb> [--flags]`
 * grammar. Flags-only by design (see plan): the only positionals are the noun,
 * the verb, and a small number of verb-specific operands (e.g. an item id).
 */
import { usageError } from './exitCodes.js';

export interface ParsedArgs {
  noun?: string;
  verb?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set([
  'json',
  'csv',
  'quiet',
  'q',
  'all',
  'live',
  'offline',
  'no-color',
  'archived',
  'link-session',
  'help',
  'h',
  'version',
]);

/**
 * Flags that are boolean on their own but take a value when one follows.
 * `--version` is the CLI's own version flag (`nim --version`) *and* the release
 * version (`nim release finalize --version 0.71.0`); which one it is depends on
 * whether a value comes next.
 */
const VALUE_OR_BOOLEAN_FLAGS = new Set(['version']);

/** Flags that may be repeated; their values accumulate into an array. */
const REPEATABLE_FLAGS = new Set(['where', 'tag', 'field', 'unset', 'column', 'label', 'type-tag']);

const ALIASES: Record<string, string> = {
  q: 'quiet',
  h: 'help',
  f: 'file',
};

/** Parse process argv (already sliced past node + script). */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token === '--') {
      // Everything after `--` is a positional.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      let name = eq >= 0 ? body.slice(0, eq) : body;
      let inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;
      name = ALIASES[name] ?? name;

      if (VALUE_OR_BOOLEAN_FLAGS.has(name) && inlineValue === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          flags[name] = true;
          i += 1;
          continue;
        }
        assignFlag(flags, name, next);
        i += 2;
        continue;
      }

      if (BOOLEAN_FLAGS.has(name) && inlineValue === undefined) {
        flags[name] = true;
        i += 1;
        continue;
      }

      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) {
          throw usageError(`Flag --${name} expects a value`);
        }
        value = next;
        i += 1;
      }
      assignFlag(flags, name, value);
      i += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      // short flag cluster, e.g. -q
      const short = token.slice(1);
      const name = ALIASES[short] ?? short;
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) throw usageError(`Flag -${short} expects a value`);
      assignFlag(flags, name, next);
      i += 2;
      continue;
    }

    positionals.push(token);
    i += 1;
  }

  return {
    noun: positionals[0],
    verb: positionals[1],
    positionals: positionals.slice(2),
    flags,
  };
}

function assignFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string,
): void {
  if (REPEATABLE_FLAGS.has(name)) {
    const existing = flags[name];
    if (Array.isArray(existing)) existing.push(value);
    else flags[name] = [value];
    return;
  }
  flags[name] = value;
}

// ---- typed accessors -------------------------------------------------------

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  return [];
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw usageError(`Flag --${name} expects an integer, got "${v}"`);
  return n;
}
