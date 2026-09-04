/**
 * Where the harness gets an embedding API key.
 *
 * Deliberately NOT `process.env`. Reading a provider key out of the ambient
 * environment is a hard prohibition in this repo: a user with an unrelated
 * `ANTHROPIC_API_KEY` in a `.env` had it silently picked up, persisted, and
 * billed for $100+. The rule is about the product, but a dev script that
 * normalises "just export the key" trains exactly the habit the rule exists to
 * prevent, and a harness that quietly spends a key nobody pointed it at is its
 * own small version of the same incident.
 *
 * So: the key comes from a JSON settings file the operator names, read at a
 * dotted field path. The mechanism is generic — a JSON file and a field — which
 * keeps this module free of host concepts even though its default happens to
 * point at where the desktop app stores settings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

/** Field within the settings JSON holding the OpenAI key. */
export const DEFAULT_KEY_FIELD = 'apiKeys.openai';

/**
 * The desktop app's AI settings file, per platform. A data table rather than a
 * code path so a new platform is one line and a wrong guess is visible.
 */
export function defaultKeyFileCandidates(home = homedir(), plat = platform()): string[] {
  const app = '@nimbalyst/electron';
  const roots =
    plat === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', app)]
      : plat === 'win32'
        ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), app)]
        : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), app)];
  return roots.map((r) => path.join(r, 'ai-settings.json'));
}

/** Read a dotted path out of a parsed JSON object. Returns null if absent. */
export function readDotted(obj: unknown, dotted: string): string | null {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

export interface KeyLookup {
  key: string | null;
  /** Where it came from, or why it was not found. Printed, never the key. */
  detail: string;
}

/**
 * Resolve an API key from a settings file. `file` defaults to the desktop app's
 * settings; pass an explicit path to point the harness at anything else.
 */
export function resolveApiKey(file?: string, field = DEFAULT_KEY_FIELD): KeyLookup {
  const candidates = file ? [file] : defaultKeyFileCandidates();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (err) {
      return { key: null, detail: `${candidate} is not valid JSON: ${(err as Error).message}` };
    }
    const key = readDotted(parsed, field);
    if (key) return { key, detail: `${candidate} (${field})` };
    return { key: null, detail: `${candidate} has no ${field}` };
  }
  return { key: null, detail: `no settings file found (looked in: ${candidates.join(', ')})` };
}
