import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryEngine } from '../engine.js';
import { createMcpServer } from '../mcp/server.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { EngineConfig } from '../types.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bootEngine(): Promise<MemoryEngine> {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-mcp-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(
    path.join(root, 'docs/voice.md'),
    '# Voice Agent\nThe realtime voice agent calls grounding tools over MCP for sub-second answers.'
  );
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
  const engine = MemoryEngine.create(config, new FakeEmbedder());
  await engine.indexAll();
  return engine;
}

async function connect(engine: MemoryEngine): Promise<Client> {
  const server = createMcpServer(engine);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

function parse(result: unknown): unknown {
  const r = result as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0].text);
}

describe('MCP server adapter (end-to-end over in-memory transport)', () => {
  it('lists the expected tools', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['expand', 'index', 'read_doc', 'recall', 'remember', 'search_project_knowledge', 'status'].sort()
    );
    await engine.close();
  });

  it('search_project_knowledge returns grounded chunks with citations', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const res = parse(
      await client.callTool({ name: 'search_project_knowledge', arguments: { query: 'realtime voice grounding', k: 3 } })
    ) as { chunks: { sourcePath: string; citation: string }[] };
    expect(res.chunks[0].sourcePath).toBe('docs/voice.md');
    expect(res.chunks[0].citation).toContain('docs/voice.md');
    await engine.close();
  });

  it('remember then recall round-trips a fact through MCP', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const wrote = parse(
      await client.callTool({ name: 'remember', arguments: { text: 'Voice mode is Cmd+Shift+A', category: 'shortcut', priority: 7 } })
    ) as { ok: boolean; path: string };
    expect(wrote.ok).toBe(true);

    const recalled = parse(
      await client.callTool({ name: 'recall', arguments: { query: 'voice mode shortcut' } })
    ) as { facts: { text: string }[] };
    expect(recalled.facts.some((f) => f.text.includes('Cmd+Shift+A'))).toBe(true);
    await engine.close();
  });

  it('status reports the embedder and chunk count', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const status = parse(await client.callTool({ name: 'status', arguments: {} })) as {
      chunks: number;
      embedder: { id: string };
    };
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.embedder.id).toBe('fake');
    await engine.close();
  });

  it('read_doc rejects path traversal outside the root', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const res = (await client.callTool({
      name: 'read_doc',
      arguments: { path: '../../etc/passwd' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/escapes engine root/);
    await engine.close();
  });
});
