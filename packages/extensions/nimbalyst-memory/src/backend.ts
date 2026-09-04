/**
 * Nimbalyst Memory — backend module.
 *
 * Runs in an Electron utility-process (outside main and the renderer). It hosts
 * the host-agnostic `MemoryEngine` directly (NOT over the engine's stdio MCP
 * server): better-sqlite3 shadow store, fs walk, and optional embeddings.
 * It exposes the engine's capabilities as backend RPC methods and registers
 * them with the host's unified MCP surface via `services.registerMcpTools`, so
 * the coding agent and (for voice-flagged tools) the voice agent reach the
 * engine in-process — sub-second, no 60s `ask_coding_agent` round-trip.
 *
 * Optional provider state comes ONLY from the `getApiKey` broker (explicit
 * Nimbalyst configuration), never `process.env` (CLAUDE.md rule). Without it,
 * the engine starts in local keyword-only mode.
 *
 * The method-name keys below MUST match the `name`s passed to registerMcpTools:
 * the host advertises `<ext-short>.<name>` and routes a call back to the RPC
 * method of the same `name`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MemoryEngine } from '../engine/dist/index.js';
import {
  buildProjectSearchResponse,
  buildPublicEngineStatus,
  createEmbedder,
  defaultSources,
} from '../engine/dist/index.js';
import type { EngineConfig, SearchHit, VirtualRecord } from '../engine/dist/index.js';
// The write gate. It runs on the LIVE `remember` path below rather than at
// export time, because a credential is already a problem once it is on disk in
// a fact file — waiting for the phase 4 replica to filter it would mean every
// fact stored between now and then was screened by nothing.
import { screenMemoryText } from '../engine/dist/redaction/index.js';
// Deep imports rather than the engine barrel: the local-embedder surface is
// self-contained, and pulling it through `index.js` would drag the barrel into
// this module's import graph for no benefit.
import {
  downloadModel,
  isLocalEmbedderSupported,
  isModelCached,
  type ModelDownloadProgress,
} from '../engine/dist/embedders/localEmbedder.js';
import {
  readLocalEmbeddingPrefs,
  writeLocalEmbeddingPrefs,
} from '../engine/dist/embedders/localEmbeddingPrefs.js';
import {
  defaultLocalModel,
  findLocalModel,
  formatDownloadSize,
  selectableLocalModels,
} from '../engine/dist/embedders/localModels.js';
import { fallbackFor, selectEmbedder } from '../engine/dist/embedders/selection.js';
import {
  buildDistillMessages,
  parseDistillResponse,
  type ChatMessage,
  type FactCandidate,
} from './distill';
import {
  buildOptionalAiUnavailableResult,
  retrievalKindForOptionalProvider,
} from './capabilityResults';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Subset of the host's BackendActivateContext we rely on. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    extensionPath: string;
    /**
     * Per-(extension, workspace) writable dir under the app's userData. The
     * shadow index lives here so it never lands inside the user's project tree.
     */
    dataDir: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    getApiKey: (providerId: string) => Promise<{ key: string | null }>;
    registerMcpTools: (
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        voiceAgent?: boolean;
        scope?: 'global' | 'editor';
      }>
    ) => Promise<{ registered: string[] }>;
  };
}

const FACTS_DIR = 'nimbalyst-local/voice-memory';

/** Where plan markdown lives (the 'plans' source class). Nimbalyst convention,
 *  so it stays here in the app-facing backend half, not in the engine. */
const PLANS_DIR = 'nimbalyst-local/plans';

/** Cap plan/doc bodies returned to the voice agent. The Realtime model degrades
 *  on very large function results; this is enough for a summarize-back of a long
 *  plan while staying within the voice turn budget. */
const MAX_DOC_CHARS = 12000;

function capForVoice(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_DOC_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_DOC_CHARS) + '\n\n…(truncated)', truncated: true };
}

/** One entity-level result for the renderer (Quick Open), not a raw chunk. */
interface GlobalSearchResult {
  refType: string;
  refId: string;
  sourceClass: string;
  sourcePath: string;
  /** Best-chunk heading or first line, for display when the host can't enrich. */
  title: string;
  snippet: string;
  score: number;
  signals: { dense: boolean; sparse: boolean };
  /**
   * Raw pre-fusion scores from the best chunk. `score` is an RRF rank
   * reciprocal and cannot carry a threshold across queries; callers that need
   * "how similar, absolutely" (duplicate detection) read `similarity.cosine`.
   */
  similarity?: { cosine?: number; bm25?: number };
}

/**
 * Collapse chunk-level hits to one result per openable entity (a tracker or doc
 * yields several chunks; Quick Open wants one row). Keeps the best-scoring
 * chunk's snippet/title per entity, ordered by that score.
 */
function collapseToEntities(hits: SearchHit[], limit: number): GlobalSearchResult[] {
  const best = new Map<string, GlobalSearchResult>();
  for (const h of hits) {
    const key = `${h.refType}\u0000${h.refId}`;
    const prev = best.get(key);
    if (prev && h.score <= prev.score) continue;
    best.set(key, {
      refType: h.refType,
      refId: h.refId,
      sourceClass: h.sourceClass,
      sourcePath: h.sourcePath,
      title: h.headingPath[0] ?? '',
      snippet: h.text.slice(0, 240),
      score: h.score,
      signals: h.signals ?? { dense: false, sparse: false },
      ...(h.similarity ? { similarity: h.similarity } : {}),
    });
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Chat model used for auto-distillation. Cheap + good at structured extraction. */
const DISTILL_MODEL = 'gpt-4o-mini';

/**
 * One-shot OpenAI chat completion for fact distillation. Mirrors the embedder's
 * raw-fetch approach (key from the broker, never process.env) so the backend
 * module needs no extra dependency. Returns the assistant message text.
 */
async function chatComplete(messages: ChatMessage[], apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DISTILL_MODEL,
      temperature: 0,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI chat completion failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Resolve a plan reference to a root-relative path. Accepts a full relative path
 * (returned as-is) or a bare name like "voice-agent-grounding-system" / "foo.md"
 * (resolved under the plans dir, .md appended if missing).
 */
function resolvePlanPath(ref: string): string {
  const trimmed = ref.trim().replace(/^\.\//, '');
  if (trimmed.includes('/')) return trimmed;
  const withExt = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
  return `${PLANS_DIR}/${withExt}`;
}

/**
 * Tool descriptors advertised to the host. `name` doubles as the RPC method
 * name. Schemas mirror engine/src/mcp/server.ts. Voice-flagged tools are the
 * conversational essentials; the rest stay coding-agent-only.
 */
const TOOL_DESCRIPTORS = [
  {
    name: 'search_project_knowledge',
    description:
      'Search the indexed project markdown with local keyword retrieval and ' +
      'semantic matching when available ' +
      '(design docs, plans, CLAUDE.md, trackers, voice-memory). Returns the top ' +
      'matching chunks with source + heading citations. Use this to ground ' +
      'answers in how the project actually works.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        k: { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
    voiceAgent: true,
  },
  {
    name: 'recall',
    description:
      'Recall stored facts, optionally filtered by category/scope and ranked by a ' +
      'query. Newest wins when facts conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    voiceAgent: true,
  },
  {
    name: 'remember',
    description:
      'Append a durable fact to memory (ADD-only; never overwrites). Use for ' +
      'preferences, decisions, and project truths worth recalling later. ' +
      'Secrets are redacted before storage, and a page that is mostly ' +
      'credentials is refused outright (returns ok:false).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        priority: { type: 'number', description: 'Higher = injected sooner at start.' },
      },
      required: ['text'],
    },
    voiceAgent: true,
  },
  {
    name: 'expand',
    description:
      'Expand a search hit to its full heading section. Pass the sourcePath and ' +
      'headingPath from a search_project_knowledge result.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        headingPath: { type: 'array', items: { type: 'string' } },
      },
      required: ['sourcePath'],
    },
    voiceAgent: false,
  },
  {
    name: 'read_doc',
    description: 'Read a managed document by its relative path (e.g. a plan file).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    voiceAgent: false,
  },
  {
    name: 'get_latest_plan',
    description:
      'Read back the most recently edited plan document so you can summarize it ' +
      'aloud. Use this right after kicking off a /design task and being told it ' +
      'finished, or when the user asks "read me the plan" / "what does the plan ' +
      'say". Returns the plan path and its markdown body.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: true,
  },
  {
    name: 'read_plan',
    description:
      'Read a specific plan document by name or relative path so you can ' +
      'summarize or discuss it aloud. Accepts a bare plan name (e.g. ' +
      '"voice-agent-grounding-system") or a full relative path. Returns the ' +
      'plan path and its markdown body.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Plan name or root-relative path to the plan markdown.',
        },
      },
      required: ['path'],
    },
    voiceAgent: true,
  },
  {
    name: 'status',
    description: 'Report index size, the active embedder, and whether a re-index is needed.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: false,
  },
  {
    name: 'local_embeddings_status',
    description:
      'Report whether keyless on-device semantic search is available: the ' +
      'candidate models with their download sizes, which one is selected, ' +
      'whether its weights are already downloaded, and what retrieval is ' +
      'actually running right now. Read-only; downloads nothing.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: false,
  },
  {
    name: 'set_local_embeddings',
    description:
      'Turn on-device semantic search on or off. Turning it ON DOWNLOADS a ' +
      'model of tens to hundreds of megabytes (see local_embeddings_status for ' +
      'the exact size) and then re-indexes the project, so it must be a ' +
      'deliberate, user-initiated choice — never do this on your own ' +
      'initiative. Retrieval keeps working as keyword search throughout.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'True to download and enable, false to disable.' },
        modelId: {
          type: 'string',
          description: 'Candidate id from local_embeddings_status (default: the recommended one).',
        },
      },
      required: ['enabled'],
    },
    voiceAgent: false,
  },
  {
    name: 'list_facts',
    description:
      'List the durable facts currently stored in memory (the voice-memory ' +
      'markdown tree), newest/highest-priority first. Returns each fact with its ' +
      'sourcePath, text, category, scope, and priority. Used by the settings ' +
      'facts viewer.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max facts (default 200).' } },
    },
    voiceAgent: false,
  },
  {
    name: 'delete_fact',
    description:
      'Delete a stored fact by its sourcePath (as returned by list_facts). ' +
      'Removes the underlying markdown file; the chunks are pruned on the next ' +
      'index pass.',
    inputSchema: {
      type: 'object',
      properties: { sourcePath: { type: 'string' } },
      required: ['sourcePath'],
    },
    voiceAgent: false,
  },
  {
    name: 'rebuild',
    description:
      'Force a full re-index of the project markdown. Re-walks the sources, ' +
      're-chunks changed files, and refreshes the retrieval snapshot. Returns the ' +
      'number of chunks indexed and files seen.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: false,
  },
  {
    name: 'distill_candidate_facts',
    description:
      'Auto-distill CANDIDATE durable facts from the most recent project ' +
      'documents (decisions/plans by default) using an LLM extraction pass. ' +
      'Returns proposed facts WITHOUT storing them — the user confirms which to ' +
      'keep, then they are added via remember (ADD-only). Used by the settings ' +
      'facts viewer to seed memory from real project decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceClass: {
          type: 'string',
          description: "Source class to harvest (default 'plans'; e.g. 'design', 'docs').",
        },
        maxDocs: { type: 'number', description: 'How many recent docs to scan (default 3).' },
      },
    },
    voiceAgent: false,
  },
] as const;

export async function activate(ctx: ActivateCtx) {
  const { workspacePath, dataDir, log, getApiKey, registerMcpTools } = ctx.services;

  // The index (db/wal/shm) is machine-local, rebuildable state — never source.
  // It lives in the host-provided per-workspace userData dir so it stays out of
  // the user's project tree entirely.
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'index.db');

  const config: EngineConfig = {
    root: workspacePath,
    dbPath,
    factsDir: FACTS_DIR,
    sources: defaultSources(FACTS_DIR, workspacePath),
    // Keep stale/archived markdown out of the index so retrieval surfaces
    // current truth, not abandoned plans (e.g. nimbalyst-local/plans/archive/**
    // duplicating live design docs).
    exclude: ['**/archive/**'],
    // Surface engine-internal warnings (e.g. a failed query embedding that
    // would otherwise silently degrade search to sparse-only) into the host log.
    onLog: (level, message) => log(level, message),
  };

  let engine: MemoryEngine | null = null;

  // App-level, workspace-independent, outside the project tree. `dataDir` is
  // <userData>/extension-data/<ext>/<sha(workspace)>, so its parent is this
  // extension's own storage across every workspace on the machine — which is
  // the right granularity for a model that is byte-identical for all of them
  // and costs tens to hundreds of megabytes to fetch.
  const modelDir = path.join(path.dirname(dataDir), 'models');

  let apiKey: string | null = null;
  try {
    ({ key: apiKey } = await getApiKey('openai'));
  } catch {
    apiKey = null;
  }

  const prefs = readLocalEmbeddingPrefs(modelDir);
  const stored = findLocalModel(prefs.modelId);
  // A stored preference naming an asymmetric model (one written before the
  // registry knew better, or hand-edited) resolves to the default rather than
  // being run in a configuration it was not trained for.
  const localModel = stored && !stored.asymmetric ? stored : defaultLocalModel();

  // Cache-only probe. Never downloads: if the weights are absent this is false
  // and the selection degrades to keyword retrieval rather than blocking
  // activation on a network fetch.
  const localModelCached = prefs.enabled
    ? await isModelCached({ model: localModel.repo, dtype: localModel.dtype, cacheDir: modelDir })
    : false;

  let selection = selectEmbedder({
    apiKeyConfigured: retrievalKindForOptionalProvider(Boolean(apiKey)) === 'openai',
    apiKey,
    localEnabled: prefs.enabled,
    localModelCached,
    localModel: localModel.repo,
    cacheDir: modelDir,
  });

  /**
   * Build the engine for a selection and start indexing in the background.
   *
   * Called at activation and again whenever the embedder changes (the user
   * turning local embeddings on or off). Switching embedder changes the vector
   * space, so the store's `embedderChanged` check forces a full re-index —
   * which is why this is a restart of the engine and not a field assignment.
   */
  async function startEngine(want: typeof selection): Promise<void> {
    let embedder;
    try {
      embedder = await createEmbedder(want.config);
    } catch (err) {
      // Any construction failure — missing optional dependency, corrupt model
      // cache, revoked key — degrades to BM25. Retrieval never goes dark.
      want = fallbackFor(want);
      log('warn', `[memory] ${want.reason}: ${(err as Error).message}`);
      embedder = await createEmbedder(want.config);
    }
    selection = want;
    log('info', `[memory] ${want.reason}`);

    engine = MemoryEngine.create(config, embedder);
    log('info', `[memory] engine ready: root=${config.root} db=${config.dbPath}`);

    // Background initial index + live watch. Never blocks activation; the
    // tools serve a partial/empty index until the first pass completes.
    void (async () => {
      const started = engine;
      try {
        const status = started!.status();
        if (status.embedderChanged) log('info', '[memory] embedder changed — full re-index');
        const result = await started!.indexAll();
        log('info', `[memory] indexed ${result.indexed} chunk(s) across ${result.files} file(s)`);
        started!.startWatching();
        log('info', '[memory] watching for changes');
      } catch (err) {
        log('error', `[memory] initial index failed: ${(err as Error).message}`);
      }
    })();
  }

  try {
    await startEngine(selection);
  } catch (err) {
    log('error', `[memory] engine init failed: ${(err as Error).message}`);
  }

  function requireEngine(): MemoryEngine {
    if (!engine) {
      throw new Error('Local project index is unavailable.');
    }
    return engine;
  }

  await registerMcpTools(
    TOOL_DESCRIPTORS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      voiceAgent: t.voiceAgent,
      scope: 'global' as const,
    }))
  );

  return {
    methods: {
      search_project_knowledge: async (params: { query?: string; k?: number }) => {
        const query = String(params?.query ?? '');
        if (!query) throw new Error('query is required');
        const k = typeof params?.k === 'number' ? params.k : 5;
        const eng = requireEngine();
        const chunks = await eng.search(query, k);
        return buildProjectSearchResponse(chunks, eng.status().retrieval);
      },

      // --- Host-only RPC methods (not MCP tools) -----------------------------
      // Called by the main process to catalog DB-resident content (trackers,
      // sessions) and to power the Quick Open global search. Not registered with
      // registerMcpTools, so no agent sees them.

      /** Upsert virtual records (trackers/sessions) into the hybrid index. */
      ingestRecords: async (params: { records?: VirtualRecord[] }) => {
        const records = Array.isArray(params?.records) ? params.records : [];
        if (!records.length) return { ingested: 0 };
        return requireEngine().ingestRecords(records);
      },

      /** Remove virtual records by id (the same id passed to ingestRecords). */
      removeRecords: async (params: { ids?: string[] }) => {
        const ids = Array.isArray(params?.ids) ? params.ids.map(String) : [];
        requireEngine().removeRecords(ids);
        return { removed: ids.length };
      },

      /**
       * Entity-level hybrid search for Quick Open: collapses chunk hits to one
       * result per tracker/doc/session. `k` is the number of ENTITIES wanted;
       * we over-fetch chunks then collapse so multi-chunk entities don't crowd
       * the list.
       */
      globalSearch: async (params: {
        query?: string;
        k?: number;
        sourceClasses?: string[];
      }) => {
        const eng = requireEngine();
        const query = String(params?.query ?? '').trim();
        if (!query) {
          const searchResponse = buildProjectSearchResponse([], eng.status().retrieval);
          return {
            results: [] as GlobalSearchResult[],
            capabilities: searchResponse.capabilities,
            fallback: searchResponse.fallback,
          };
        }
        const k = typeof params?.k === 'number' ? params.k : 20;
        const sourceClasses = Array.isArray(params?.sourceClasses)
          ? params.sourceClasses.map(String).filter(Boolean)
          : undefined;
        const hits = await eng.search(
          query,
          Math.max(k * 4, 40),
          sourceClasses?.length ? { sourceClasses } : undefined,
        );
        const searchResponse = buildProjectSearchResponse(hits, eng.status().retrieval);
        return {
          results: collapseToEntities(hits, k),
          capabilities: searchResponse.capabilities,
          fallback: searchResponse.fallback,
        };
      },

      recall: async (params: { query?: string; category?: string; scope?: string; limit?: number }) => {
        return {
          facts: await requireEngine().recall({
            query: params?.query != null ? String(params.query) : undefined,
            category: params?.category != null ? String(params.category) : undefined,
            scope: params?.scope != null ? String(params.scope) : undefined,
            limit: typeof params?.limit === 'number' ? params.limit : undefined,
          }),
        };
      },

      remember: async (params: {
        text?: string;
        category?: string;
        scope?: string;
        priority?: number;
      }) => {
        const text = String(params?.text ?? '');
        if (!text) throw new Error('text is required');

        // Screen BEFORE the write. `remember` has stored whatever it was given
        // since v1, including an API key pasted into a session; once a team
        // shares this store that is an incident, and once it reaches the
        // committed replica it is permanent in git history.
        const screened = screenMemoryText(text);
        if (!screened.ok) {
          log('warn', `[memory] refused to store a fact: ${screened.blocks.map((b) => b.rule).join(', ')}`);
          return {
            ok: false,
            stored: false,
            reason: 'blocked-by-redaction',
            blocks: screened.blocks.map((b) => ({ rule: b.rule, reason: b.reason })),
          };
        }

        const written = await requireEngine().remember({
          text: screened.text,
          category: params?.category != null ? String(params.category) : null,
          scope: params?.scope != null ? String(params.scope) : null,
          priority: typeof params?.priority === 'number' ? params.priority : 0,
        });
        // Report the redaction rather than applying it quietly: a silent
        // rewrite is indistinguishable from a miss, and the caller should know
        // the stored fact is not what it handed over.
        return {
          ok: true,
          path: written,
          redacted: screened.redactions.length > 0,
          redactions: screened.redactions.map((r) => ({ kind: r.kind, line: r.line, preview: r.preview })),
        };
      },

      expand: async (params: { sourcePath?: string; headingPath?: unknown[] }) => {
        const sourcePath = String(params?.sourcePath ?? '');
        if (!sourcePath) throw new Error('sourcePath is required');
        const headingPath = Array.isArray(params?.headingPath)
          ? params.headingPath.map(String)
          : [];
        return requireEngine().expand(sourcePath, headingPath);
      },

      read_doc: async (params: { path?: string }) => {
        const p = String(params?.path ?? '');
        if (!p) throw new Error('path is required');
        return requireEngine().readDoc(p);
      },

      get_latest_plan: async () => {
        const latest = await requireEngine().latestDoc('plans');
        if (!latest) {
          return { found: false, message: 'No plan documents found in this project yet.' };
        }
        const { content, truncated } = capForVoice(latest.content);
        return { found: true, path: latest.path, content, truncated };
      },

      read_plan: async (params: { path?: string }) => {
        const ref = String(params?.path ?? '');
        if (!ref) throw new Error('path is required');
        const relPath = resolvePlanPath(ref);
        const doc = await requireEngine().readDoc(relPath);
        const { content, truncated } = capForVoice(doc.content);
        return { found: true, path: doc.path, content, truncated };
      },

      status: async () => {
        if (!engine) {
          return {
            ready: false,
            capability: {
              available: false,
              reason: 'local-project-index-unavailable',
            },
            root: config.root,
          };
        }
        return {
          ready: true,
          ...buildPublicEngineStatus(engine.status()),
          indexSizeBytes: await engine.indexSizeBytes(),
        };
      },

      list_facts: async (params: { limit?: number }) => {
        const limit = typeof params?.limit === 'number' ? params.limit : 200;
        return { facts: await requireEngine().recall({ limit }) };
      },

      delete_fact: async (params: { sourcePath?: string }) => {
        const sourcePath = String(params?.sourcePath ?? '');
        if (!sourcePath) throw new Error('sourcePath is required');
        const deleted = await requireEngine().deleteFact(sourcePath);
        return { deleted };
      },

      local_embeddings_status: async () => {
        const current = findLocalModel(readLocalEmbeddingPrefs(modelDir).modelId) ?? defaultLocalModel();
        const cached = await isModelCached({
          model: current.repo,
          dtype: current.dtype,
          cacheDir: modelDir,
        });
        return {
          // False when the optional dependency did not install (a platform with
          // no onnxruntime binary). The UI hides the whole control rather than
          // offering a switch that cannot work.
          supported: await isLocalEmbedderSupported(),
          enabled: readLocalEmbeddingPrefs(modelDir).enabled,
          downloaded: cached,
          // What is running RIGHT NOW, which is not the same as `enabled`:
          // opted in with the weights still downloading reads enabled+sparse.
          activeMode: selection.mode,
          activeReason: selection.reason,
          awaitingModelDownload: selection.awaitingModelDownload,
          cacheDir: modelDir,
          selectedModelId: current.id,
          models: selectableLocalModels().map((m) => ({
            id: m.id,
            repo: m.repo,
            dims: m.dims,
            languages: m.languages,
            note: m.note,
            downloadBytes: m.downloadBytes,
            downloadSize: formatDownloadSize(m.downloadBytes),
            recommended: m.id === defaultLocalModel().id,
          })),
        };
      },

      set_local_embeddings: async (params: { enabled?: boolean; modelId?: string }) => {
        const enabled = params?.enabled === true;
        // No modelId keeps whatever the user already chose, so disabling and
        // re-enabling cannot silently switch them to a different model (and a
        // different download).
        const requested = params?.modelId
          ? String(params.modelId)
          : readLocalEmbeddingPrefs(modelDir).modelId;
        const model = findLocalModel(requested) ?? defaultLocalModel();
        if (model.asymmetric) {
          // Trained with distinct query/passage prefixes, which `Embedder.embed`
          // cannot express. Refuse rather than run it wrong.
          throw new Error(
            `Local embedding model "${model.id}" needs separate query and passage prefixes, ` +
              'which this engine cannot supply yet.'
          );
        }

        if (!enabled) {
          writeLocalEmbeddingPrefs(modelDir, { enabled: false, modelId: model.id });
          // The weights stay on disk. Turning the feature off should not make
          // turning it back on cost another download.
          await engine?.close();
          await startEngine(
            selectEmbedder({
              apiKeyConfigured: retrievalKindForOptionalProvider(Boolean(apiKey)) === 'openai',
              apiKey,
              localEnabled: false,
              localModelCached: false,
              localModel: model.repo,
              cacheDir: modelDir,
            })
          );
          return { ok: true, enabled: false, activeMode: selection.mode };
        }

        // The download. The ONLY place in this extension that fetches model
        // weights, reached only from an explicit enable. Retrieval continues to
        // serve keyword results throughout — the running engine is untouched
        // until the bytes are on disk.
        let lastLoggedPct = -1;
        try {
          await downloadModel({
            model: model.repo,
            dtype: model.dtype,
            cacheDir: modelDir,
            onProgress: (p: ModelDownloadProgress) => {
              if (p.status !== 'progress' || p.progress == null) return;
              const pct = Math.floor(p.progress / 25) * 25;
              if (pct > lastLoggedPct) {
                lastLoggedPct = pct;
                log('info', `[memory] downloading ${model.repo} ${pct}%`);
              }
            },
          });
        } catch (err) {
          // A failed download leaves the opt-in unwritten and the running
          // engine alone: the user is exactly where they started, on keyword
          // retrieval, with an error to read.
          const message = (err as Error).message;
          log('warn', `[memory] local embedding model download failed: ${message}`);
          return { ok: false, enabled: false, activeMode: selection.mode, error: message };
        }

        writeLocalEmbeddingPrefs(modelDir, { enabled: true, modelId: model.id });
        await engine?.close();
        await startEngine(
          selectEmbedder({
            apiKeyConfigured: retrievalKindForOptionalProvider(Boolean(apiKey)) === 'openai',
            apiKey,
            localEnabled: true,
            localModelCached: true,
            localModel: model.repo,
            cacheDir: modelDir,
          })
        );
        return { ok: true, enabled: true, activeMode: selection.mode, model: model.repo };
      },

      rebuild: async () => {
        const result = await requireEngine().indexAll();
        log('info', `[memory] rebuild: indexed ${result.indexed} chunk(s) across ${result.files} file(s)`);
        return { ok: true, ...result };
      },

      distill_candidate_facts: async (params: { sourceClass?: string; maxDocs?: number }) => {
        const eng = requireEngine();
        const sourceClass = params?.sourceClass ? String(params.sourceClass) : 'plans';
        const maxDocs = typeof params?.maxDocs === 'number' ? params.maxDocs : 3;

        let key: string | null = null;
        try {
          ({ key } = await getApiKey('openai'));
        } catch {
          return buildOptionalAiUnavailableResult(sourceClass);
        }
        if (!key) {
          return buildOptionalAiUnavailableResult(sourceClass);
        }

        const docs = await eng.recentDocs(sourceClass, maxDocs);
        if (docs.length === 0) {
          return { candidates: [] as FactCandidate[], sources: [], sourceClass };
        }

        const existing = (await eng.recall({ limit: 500 })).map((f) => f.text);
        const messages = buildDistillMessages(docs.map((d) => ({ path: d.path, content: d.content })));
        let responseText: string;
        try {
          responseText = await chatComplete(messages, key);
        } catch {
          log('warn', '[memory] optional fact distillation unavailable');
          return buildOptionalAiUnavailableResult(sourceClass);
        }
        const candidates = parseDistillResponse(responseText, existing);
        const sources = docs.map((d) => d.path);
        log('info', `[memory] distilled ${candidates.length} candidate fact(s) from ${sources.length} ${sourceClass} doc(s)`);
        return { candidates, sources, sourceClass };
      },
    },

    deactivate: async () => {
      await engine?.close();
    },
  };
}
