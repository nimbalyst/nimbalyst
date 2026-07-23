#!/usr/bin/env node
/**
 * Thin stdio MCP launcher for the memory engine.
 *
 * Configuration is supplied explicitly at launch (env or a JSON config file) —
 * the engine NEVER reads an API key from the ambient environment as an implicit
 * app credential. The host (or a standalone user) passes the key in deliberately.
 *
 * Env:
 *   NIMBALYST_MEMORY_ROOT          index/resolve root (default: cwd)
 *   NIMBALYST_MEMORY_DB            shadow-index path (default: <root>/.nimbalyst-memory/index.db)
 *   NIMBALYST_MEMORY_FACTS_DIR     facts dir, relative (default: nimbalyst-local/voice-memory)
 *   NIMBALYST_MEMORY_CONFIG        path to a JSON config file (overrides sources/factsDir/chunk)
 *   NIMBALYST_MEMORY_EMBEDDER      "sparse" | "openai" | "local" (default: sparse)
 *   NIMBALYST_MEMORY_OPENAI_KEY    explicit value for the openai embedder
 *   NIMBALYST_MEMORY_OPENAI_MODEL  default: text-embedding-3-small
 *   NIMBALYST_MEMORY_OPENAI_DIMS   default: 1536
 *   NIMBALYST_MEMORY_OPENAI_BASEURL  optional OpenAI-compatible base URL
 *   NIMBALYST_MEMORY_LOCAL_MODEL   default: Xenova/bge-m3
 *   NIMBALYST_BETTER_SQLITE3_NATIVE  optional native-binding path (ABI portability)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryEngine } from './engine.js';
import { createEmbedder, type EmbedderConfig } from './embedders/factory.js';
import { createMcpServer } from './mcp/server.js';
import type { EngineConfig, SourceSet } from './types.js';

const log = (msg: string) => process.stderr.write(`[memory-engine] ${msg}\n`);

function defaultSources(factsDir: string): SourceSet[] {
  return [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md'] },
    { sourceClass: 'facts', include: [`${factsDir}/**/*.md`] },
  ];
}

function buildConfig(): EngineConfig {
  const root = path.resolve(process.env.NIMBALYST_MEMORY_ROOT || process.cwd());
  const factsDir = process.env.NIMBALYST_MEMORY_FACTS_DIR || 'nimbalyst-local/voice-memory';
  const dbPath = path.resolve(
    process.env.NIMBALYST_MEMORY_DB || path.join(root, '.nimbalyst-memory', 'index.db')
  );
  mkdirSync(path.dirname(dbPath), { recursive: true });

  let sources = defaultSources(factsDir);
  let chunk: EngineConfig['chunk'];
  const configFile = process.env.NIMBALYST_MEMORY_CONFIG;
  if (configFile) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<EngineConfig>;
      if (parsed.sources) sources = parsed.sources;
      if (parsed.chunk) chunk = parsed.chunk;
    } catch (err) {
      log(`failed to read config file ${configFile}: ${(err as Error).message}`);
    }
  }

  return {
    root,
    dbPath,
    factsDir,
    sources,
    chunk,
    nativeBinding: process.env.NIMBALYST_BETTER_SQLITE3_NATIVE || undefined,
  };
}

function buildEmbedderConfig(): EmbedderConfig {
  const kind = (process.env.NIMBALYST_MEMORY_EMBEDDER || 'sparse').toLowerCase();
  if (kind === 'sparse') {
    return { kind: 'sparse' };
  }
  if (kind === 'local') {
    return { kind: 'local', model: process.env.NIMBALYST_MEMORY_LOCAL_MODEL };
  }
  if (kind === 'openai') {
    const apiKey = process.env.NIMBALYST_MEMORY_OPENAI_KEY;
    if (!apiKey) {
      log('optional semantic matching is unavailable; using local keyword retrieval');
      return { kind: 'sparse' };
    }
    return {
      kind: 'openai',
      apiKey,
      model: process.env.NIMBALYST_MEMORY_OPENAI_MODEL,
      dims: process.env.NIMBALYST_MEMORY_OPENAI_DIMS
        ? Number(process.env.NIMBALYST_MEMORY_OPENAI_DIMS)
        : undefined,
      baseUrl: process.env.NIMBALYST_MEMORY_OPENAI_BASEURL,
    };
  }
  throw new Error(`Unknown embedder kind: ${kind}`);
}

async function main(): Promise<void> {
  const config = buildConfig();
  const embedderConfig = buildEmbedderConfig();
  log(`root=${config.root} db=${config.dbPath} embedder=${embedderConfig.kind}`);

  const embedder = await createEmbedder(embedderConfig);
  const engine = MemoryEngine.create(config, embedder);

  // Connect first so the server is responsive immediately; serve partial/empty
  // results until the initial index completes.
  const server = createMcpServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected (stdio)');

  // Background initial index + live watch.
  void (async () => {
    try {
      const status = engine.status();
      if (status.embedderChanged) log('embedder changed — full re-index');
      const result = await engine.indexAll((p) => {
        if (p.phase === 'index' && p.done % 100 === 0) log(`indexing ${p.done}/${p.total}`);
      });
      log(`indexed ${result.indexed} chunk(s) across ${result.files} file(s)`);
      engine.startWatching();
      log('watching for changes');
    } catch (err) {
      log(`initial index failed: ${(err as Error).message}`);
    }
  })();

  const shutdown = async () => {
    log('shutting down');
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
