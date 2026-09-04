/**
 * The user's local-embeddings opt-in, persisted next to the weights.
 *
 * It lives in the shared model directory rather than in the per-workspace data
 * dir on purpose: the thing being consented to is a machine-wide download, so
 * consenting once per project would mean re-asking for a model that is already
 * on disk. Both the preference and the bytes it authorises are app-level, and
 * keeping them in one directory means removing that directory removes both.
 *
 * The file is deliberately tiny and defaults-on-read. Anything unreadable,
 * unparseable, or written by a newer version reads as "not opted in", which is
 * the safe direction: the worst case is keyword retrieval, never a surprise
 * download.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOCAL_MODEL_ID } from './localModels.js';

export interface LocalEmbeddingPrefs {
  /** The user explicitly turned local embeddings on. Default false. */
  enabled: boolean;
  /** Registry id from `localModels.ts`. */
  modelId: string;
}

const FILE = 'local-embeddings.json';

export function prefsPath(modelDir: string): string {
  return path.join(modelDir, FILE);
}

export function defaultPrefs(): LocalEmbeddingPrefs {
  return { enabled: false, modelId: DEFAULT_LOCAL_MODEL_ID };
}

export function readLocalEmbeddingPrefs(modelDir: string): LocalEmbeddingPrefs {
  try {
    const raw = JSON.parse(readFileSync(prefsPath(modelDir), 'utf8')) as Partial<LocalEmbeddingPrefs>;
    return {
      enabled: raw.enabled === true,
      modelId: typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : DEFAULT_LOCAL_MODEL_ID,
    };
  } catch {
    return defaultPrefs();
  }
}

export function writeLocalEmbeddingPrefs(modelDir: string, prefs: LocalEmbeddingPrefs): void {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(prefsPath(modelDir), JSON.stringify(prefs, null, 2) + '\n', 'utf8');
}
