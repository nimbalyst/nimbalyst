// Read the model catalog from the bundled codex binary via `model/list` (#1891).
//
// Nimbalyst's Codex picker used to show only a hardcoded list, so a model the
// bundled codex already supported (for example a new gpt-6.x variant) stayed
// unselectable until that list was edited and a release shipped. Asking the
// binary itself keeps the picker in step with whatever codex version is
// bundled. The hardcoded list stays as the fallback and as the source of
// context-window metadata, which `model/list` does not report.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcClient } from './jsonRpcClient';
import { getCodexVendorPathEntries } from './codexAppServerBinary';

export interface CodexCatalogModel {
  id: string;
  displayName?: string;
  hidden: boolean;
  isDefault: boolean;
}

export interface ListCodexCatalogModelsOptions {
  binaryPath: string;
  apiKey?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// Pagination guard: a server that keeps returning a cursor must not spin forever.
const MAX_PAGES = 10;

/**
 * Normalize one `model/list` page. Tolerates missing or malformed fields so a
 * schema change in a newer codex degrades to "fewer models", never a throw.
 */
export function parseCodexModelListPage(result: unknown): { models: CodexCatalogModel[]; nextCursor: string | null } {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const data = Array.isArray(record.data) ? record.data : [];
  const models: CodexCatalogModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    // `model` is the id sent on thread/start; `id` is the catalog key. They
    // match today, but prefer the one codex actually accepts as a model.
    const id = typeof item.model === 'string' && item.model.trim()
      ? item.model.trim()
      : typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : undefined,
      hidden: item.hidden === true,
      isDefault: item.isDefault === true,
    });
  }
  const nextCursor = typeof record.nextCursor === 'string' && record.nextCursor ? record.nextCursor : null;
  return { models, nextCursor };
}

/**
 * Spawn `codex app-server`, page through `model/list`, and shut the child down.
 * Rejects on spawn, initialize, or request failure; callers treat that as
 * "catalog unavailable" and fall back to the static list.
 */
export async function listCodexCatalogModels(options: ListCodexCatalogModelsOptions): Promise<CodexCatalogModel[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const vendorPath = getCodexVendorPathEntries(options.binaryPath);
  if (vendorPath.length > 0) {
    const existing = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
    env.PATH = Array.from(new Set([...vendorPath, ...existing])).join(path.delimiter);
    delete env.Path;
  }
  if (options.apiKey) env.CODEX_API_KEY = options.apiKey;

  const child = spawn(options.binaryPath, ['app-server', '--listen', 'stdio://'], {
    env,
    cwd: os.homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  // Drain stderr so a chatty child cannot block on a full pipe.
  child.stderr.resume();
  const client = new JsonRpcClient(child, {
    defaultTimeoutMs: timeoutMs,
    logger: {
      log: () => {},
      warn: (m, ...a) => console.warn('[CODEX][MODELS]', m, ...a),
    },
  });

  try {
    await client.request('initialize', {
      clientInfo: { name: 'nimbalyst-model-catalog', version: process.env.NIMBALYST_VERSION ?? '0.0.0' },
    });
    client.notify('initialized', {});
    const models: CodexCatalogModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.request('model/list', cursor ? { cursor } : {});
      const parsed = parseCodexModelListPage(result);
      models.push(...parsed.models);
      cursor = parsed.nextCursor;
      if (!cursor) break;
    }
    return models;
  } finally {
    client.close('[CODEX][MODELS] catalog read complete');
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  }
}
