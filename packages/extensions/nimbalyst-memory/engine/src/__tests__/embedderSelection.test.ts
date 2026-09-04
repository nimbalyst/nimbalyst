// @vitest-environment node
/**
 * The embedder decision, and the paths where it has to give up gracefully.
 *
 * None of this touches transformers.js or downloads a model on purpose: what is
 * worth regression-testing here is *which* backend runs and *what happens when
 * the intended one is unavailable*, and those are the branches you cannot
 * otherwise reach — a real run needs an API key, a real utility process, and
 * hundreds of megabytes of weights on disk. The embedding values themselves are
 * the model's business and are covered by the golden-set harness, not by unit
 * tests.
 */
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fallbackFor, selectEmbedder } from '../embedders/selection.js';
import { resolveModelCacheDir } from '../embedders/modelCache.js';
import {
  defaultLocalModel,
  findLocalModel,
  formatDownloadSize,
  LOCAL_MODELS,
  parseLocalModelSpec,
  selectableLocalModels,
} from '../embedders/localModels.js';
import {
  readLocalEmbeddingPrefs,
  writeLocalEmbeddingPrefs,
} from '../embedders/localEmbeddingPrefs.js';

const REPO = defaultLocalModel().repo;

describe('selectEmbedder', () => {
  it('runs the local model when the user opted in and the weights are on disk', () => {
    const s = selectEmbedder({
      apiKeyConfigured: false,
      localEnabled: true,
      localModelCached: true,
      localModel: REPO,
      cacheDir: '/tmp/models',
    });
    expect(s.mode).toBe('local');
    expect(s.config).toEqual({
      kind: 'local',
      model: REPO,
      cacheDir: '/tmp/models',
      // Starting the engine must never be able to trigger a download.
      allowDownload: false,
    });
    expect(s.awaitingModelDownload).toBe(false);
  });

  it('degrades to keyword retrieval while the opted-in model is still missing', () => {
    const s = selectEmbedder({
      apiKeyConfigured: false,
      localEnabled: true,
      localModelCached: false,
      localModel: REPO,
    });
    expect(s.mode).toBe('sparse');
    expect(s.awaitingModelDownload).toBe(true);
    expect(s.reason).toContain('not downloaded yet');
  });

  it('does not fall back to the paid provider while local weights are downloading', () => {
    // The user asked for on-device embeddings. Silently spending their API
    // credits in the gap would be a surprise charge, not a graceful fallback.
    const s = selectEmbedder({
      apiKeyConfigured: true,
      apiKey: 'sk-configured',
      localEnabled: true,
      localModelCached: false,
    });
    expect(s.mode).toBe('sparse');
  });

  it('prefers the local model over a configured key once it is downloaded', () => {
    const s = selectEmbedder({
      apiKeyConfigured: true,
      apiKey: 'sk-configured',
      localEnabled: true,
      localModelCached: true,
    });
    expect(s.mode).toBe('local');
  });

  it('uses an explicitly configured key when local embeddings are off', () => {
    const s = selectEmbedder({
      apiKeyConfigured: true,
      apiKey: 'sk-configured',
      localEnabled: false,
      localModelCached: false,
    });
    expect(s.mode).toBe('openai');
    expect(s.config).toEqual({ kind: 'openai', apiKey: 'sk-configured' });
  });

  it('is keyword-only with no key and no local opt-in', () => {
    const s = selectEmbedder({
      apiKeyConfigured: false,
      localEnabled: false,
      localModelCached: false,
    });
    expect(s.mode).toBe('sparse');
  });

  it('never treats a missing key value as configured', () => {
    // `apiKeyConfigured` is derived from the settings broker; a true flag with
    // no value must not produce an OpenAI embedder holding `null`.
    const s = selectEmbedder({
      apiKeyConfigured: true,
      apiKey: null,
      localEnabled: false,
      localModelCached: false,
    });
    expect(s.mode).toBe('sparse');
  });
});

describe('fallbackFor', () => {
  it('sends a failed local load to keyword retrieval, not to the paid provider', () => {
    const local = selectEmbedder({
      apiKeyConfigured: true,
      apiKey: 'sk-configured',
      localEnabled: true,
      localModelCached: true,
    });
    const fallback = fallbackFor(local);
    expect(fallback.mode).toBe('sparse');
    expect(fallback.reason).toContain('failed to load');
  });

  it('is a fixed point on sparse, so a caller cannot loop', () => {
    const sparse = selectEmbedder({
      apiKeyConfigured: false,
      localEnabled: false,
      localModelCached: false,
    });
    expect(fallbackFor(sparse)).toBe(sparse);
  });
});

describe('model cache location', () => {
  it('is absolute and outside any project tree', () => {
    // transformers.js defaults `env.cacheDir` to './.cache', which in the
    // utility process resolves inside the user's repo. This is the guard.
    const dir = resolveModelCacheDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(process.cwd() + path.sep)).toBe(false);
    expect(dir).toContain('memory-models');
  });
});

describe('local model registry', () => {
  it('resolves its own declared default', () => {
    expect(defaultLocalModel()).toBeDefined();
  });

  it('resolves candidates by short id and by repo', () => {
    expect(findLocalModel('minilm')?.repo).toBe('Xenova/all-MiniLM-L6-v2');
    expect(findLocalModel('Xenova/all-MiniLM-L6-v2')?.id).toBe('minilm');
    expect(findLocalModel('nope')).toBeUndefined();
  });

  it('never defaults to a model the Embedder contract cannot drive', () => {
    // An asymmetric model needs different prefixes for queries and passages,
    // which `embed(texts)` cannot express — shipping one as the default would
    // run it in a configuration its authors warn against.
    expect(defaultLocalModel().asymmetric).toBeFalsy();
  });

  it('does not offer asymmetric models for selection, but keeps them scorable', () => {
    expect(LOCAL_MODELS.some((m) => m.asymmetric)).toBe(true);
    expect(selectableLocalModels().some((m) => m.asymmetric)).toBe(false);
  });

  it('pins the pooling each model was trained with', () => {
    // Mean-pooling a BGE model measures something nobody trained, and it fails
    // silently — the vectors are the wrong shape of wrong, not an error.
    expect(findLocalModel('bge-small')?.pooling).toBe('cls');
    expect(findLocalModel('minilm')?.pooling).toBe('mean');
  });

  it('round-trips a fully qualified model id', () => {
    // `EmbedderInfo.model` reports this form, and the store compares it to
    // decide whether an index is still valid. Feeding it back in must reproduce
    // the same vector space rather than silently falling back to defaults.
    expect(parseLocalModelSpec('Xenova/bge-small-en-v1.5@q8/cls')).toEqual({
      repo: 'Xenova/bge-small-en-v1.5',
      dtype: 'q8',
      pooling: 'cls',
    });
    // The repo's own slash is not the pooling separator.
    expect(parseLocalModelSpec('Xenova/bge-m3')).toEqual({
      repo: 'Xenova/bge-m3',
      dtype: undefined,
      pooling: undefined,
    });
  });

  it('states a download size for every candidate', () => {
    // The consent prompt quotes these. A zero would understate the cost.
    for (const m of LOCAL_MODELS) expect(m.downloadBytes).toBeGreaterThan(0);
  });

  it('formats sizes the way a consent prompt reads them', () => {
    expect(formatDownloadSize(23_685_047)).toBe('23 MB');
    expect(formatDownloadSize(2_100_000_000)).toBe('2.0 GB');
  });
});

describe('local embedding preferences', () => {
  it('reads as opted-out when nothing has been written', () => {
    // The safe direction: an unreadable or absent preference must never be
    // interpreted as consent to a several-hundred-megabyte download.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memprefs-'));
    expect(readLocalEmbeddingPrefs(dir).enabled).toBe(false);
  });

  it('reads as opted-out when the file is corrupt', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memprefs-'));
    writeFileSync(path.join(dir, 'local-embeddings.json'), '{ not json');
    expect(readLocalEmbeddingPrefs(dir).enabled).toBe(false);
  });

  it('round-trips an opt-in', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memprefs-'));
    writeLocalEmbeddingPrefs(dir, { enabled: true, modelId: 'minilm' });
    expect(readLocalEmbeddingPrefs(dir)).toEqual({ enabled: true, modelId: 'minilm' });
  });
});
