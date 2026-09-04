/**
 * Which embedder to run, as a pure function of the facts.
 *
 * The decision lives here rather than inline in `backend.ts` because every
 * interesting branch is one you cannot reproduce from a test that has a real
 * utility process, a real API key broker, and a real half-gigabyte model on
 * disk. Extracted, the plan is a value you can assert on: the environment is
 * read once at the call site and the choice is testable without any of it
 * (see `.claude/rules/destructive-data-paths.md`, "extract the decision from
 * the environment" — the same reasoning applies to any branch that only fires
 * under conditions the suite cannot create).
 *
 * The rules, in order:
 *
 *  1. **Local wins when the user opted in and the weights are on disk.** Opting
 *     in is an explicit act, it costs nothing per query, and nothing leaves the
 *     machine. It outranks a configured API key because the user asked for it
 *     more recently and more specifically.
 *  2. **Opted in but the model is not downloaded yet is `sparse`, not an
 *     error.** This is the first-run state and the reason a several-hundred-
 *     megabyte download is safe to offer at all: retrieval keeps working as
 *     BM25 while the weights arrive, then a re-index upgrades it.
 *  3. **An explicitly configured API key is the fallback**, unchanged from
 *     today's behaviour, so nobody's working setup changes underneath them.
 *  4. **Otherwise BM25.** A complete product with no account and no key.
 *
 * `apiKeyConfigured` means a key the user put into Nimbalyst settings. It is
 * never `process.env` — see the header of `backend.ts` and the CLAUDE.md rule.
 */
import type { EmbedderConfig } from './factory.js';
import { DEFAULT_LOCAL_MODEL } from './localEmbedder.js';

export type EmbedderMode = 'local' | 'openai' | 'sparse';

export interface EmbedderSelectionInput {
  /** A key present in explicit Nimbalyst settings. Never from the environment. */
  apiKeyConfigured: boolean;
  /** The user turned local embeddings on. Default off. */
  localEnabled: boolean;
  /** The selected model's weights are already in the shared cache. */
  localModelCached: boolean;
  /** Repo id the user selected; defaults to {@link DEFAULT_LOCAL_MODEL}. */
  localModel?: string;
  /** Absolute shared model cache dir. */
  cacheDir?: string;
  /** API key value, only read when `apiKeyConfigured` is true. */
  apiKey?: string | null;
}

export interface EmbedderSelection {
  mode: EmbedderMode;
  config: EmbedderConfig;
  /** Human-readable, logged verbatim. Says why, not just what. */
  reason: string;
  /**
   * True when the user wants local embeddings but the weights are not there
   * yet. The caller surfaces this as "downloading / not downloaded" rather than
   * as a failure.
   */
  awaitingModelDownload: boolean;
}

export function selectEmbedder(input: EmbedderSelectionInput): EmbedderSelection {
  const model = input.localModel || DEFAULT_LOCAL_MODEL;

  if (input.localEnabled && input.localModelCached) {
    return {
      mode: 'local',
      config: {
        kind: 'local',
        model,
        ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
        // Never download as a side effect of starting up. Weights arrive only
        // through the explicit download action.
        allowDownload: false,
      },
      reason: `local embeddings active (${model})`,
      awaitingModelDownload: false,
    };
  }

  if (input.localEnabled && !input.localModelCached) {
    return {
      mode: 'sparse',
      config: { kind: 'sparse' },
      reason: `local embedding model "${model}" is not downloaded yet; keyword retrieval active`,
      awaitingModelDownload: true,
    };
  }

  if (input.apiKeyConfigured && input.apiKey) {
    return {
      mode: 'openai',
      config: { kind: 'openai', apiKey: input.apiKey },
      reason: 'semantic matching via the configured embedding provider',
      awaitingModelDownload: false,
    };
  }

  return {
    mode: 'sparse',
    config: { kind: 'sparse' },
    reason: 'optional semantic matching unavailable; local keyword retrieval active',
    awaitingModelDownload: false,
  };
}

/**
 * What to fall back to when the selected embedder fails to construct — a
 * corrupt model cache, a revoked key, a missing optional dependency.
 *
 * Always BM25, never nothing. `sparse` returns itself so a caller cannot loop.
 */
export function fallbackFor(selection: EmbedderSelection): EmbedderSelection {
  if (selection.mode === 'sparse') return selection;
  return {
    mode: 'sparse',
    config: { kind: 'sparse' },
    reason:
      selection.mode === 'local'
        ? 'local embedding model failed to load; keyword retrieval active'
        : 'optional semantic matching unavailable; local keyword retrieval active',
    awaitingModelDownload: false,
  };
}
