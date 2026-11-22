// @vitest-environment node
/**
 * `nim mcp` as a client sees it: a real process, JSON-RPC lines on stdin, and
 * nothing on stdout but protocol. The entry is bundled with esbuild (as
 * scripts/build.mjs does) so the test needs no prior build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { initWiki, openWiki } from '@nimbalyst/local-wiki';
import { PAGE_TOOL_NAMES, pageToolContract } from '@nimbalyst/collab-protocol';
import { handleMessage, runStdioServer } from '../stdioServer.js';
import { TeamScopeRefusal, ToolMap, textResult } from '../toolMap.js';
import { resolvePluginWorkspace } from '../pluginWorkspace.js';
import { pluginServerSetup } from '../pluginEntry.js';
import { writeMigratedTo } from '../../localWiki/locate.js';
import { createLocalToolMap, LOCAL_SERVER_INSTRUCTIONS, localWikiContext } from '../serverTools.js';
import { detectNpmInstall, detectPluginInstall, startUpdateCheck, type PluginInstall } from '../updateCheck.js';

const EDITOR_TOOLS = ['mindmap_get_document', 'mindmap_apply_operations', 'excalidraw_get_elements', 'excalidraw_add_elements', 'excalidraw_add_arrows', 'excalidraw_remove_elements'];
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(packageDir, '../..');
let outDir = '';
let entry = '';

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), 'nim-mcp-'));
  entry = path.join(outDir, 'cli.mjs');
  await build({
    absWorkingDir: packageDir,
    entryPoints: ['src/bin/cli.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
    define: { __NIM_VERSION__: JSON.stringify('0.0.0-test') },
    alias: {
      '@nimbalyst/tracker-core': path.join(repoRoot, 'packages/tracker-core/src/index.ts'),
      '@nimbalyst/local-wiki': path.join(repoRoot, 'packages/local-wiki/src/index.ts'),
      '@nimbalyst/collab-protocol': path.join(repoRoot, 'packages/collab-protocol/src/index.ts'),
      '@nimbalyst/runtime/core/pageMarkSyntax': path.join(repoRoot, 'packages/runtime/src/core/pageMarkSyntax.ts'),
      // As in scripts/build.mjs: the session-inputs server `nim hook` runs.
      '@nimbalyst/wiki-plugin/session-inputs': path.join(repoRoot, 'packages/extensions/knowledge/src/sessionInputs/server.ts'),
      '@nimbalyst/runtime/core/citationSyntax': path.join(repoRoot, 'packages/runtime/src/core/citationSyntax.ts'),
      '@nimbalyst/runtime/core/textColorSyntax': path.join(repoRoot, 'packages/runtime/src/core/textColorSyntax.ts'),
      '@nimbalyst/runtime/editor/commenting/quoteMatch': path.join(repoRoot, 'packages/runtime/src/editor/commenting/quoteMatch.ts'),
    },
    logLevel: 'silent',
  });
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function runNimMcp(lines: unknown[], workspace: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'mcp', '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    for (const line of lines) child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

const LOCAL_TOOLS = [
  'listPages', 'searchPages', 'readCollabDoc', 'applyCollabDocEdit', 'createSharedDoc', 'createSharedFolder',
  'moveSharedItem', 'renameSharedItem', 'deleteSharedItem', 'setPageType', 'setPageFields',
  'tracker_list_types', 'tracker_list', 'tracker_get', 'tracker_create', 'tracker_update',
];

describe('nim mcp over stdio', () => {
  it('answers initialize and tools/list, ignores notifications, and exits when stdin closes', async () => {
    const empty = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-mcp-empty-')));
    const { stdout, stderr, code } = await runNimMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      'not json',
      { jsonrpc: '2.0', id: 4, method: 'resources/list' },
      call(5, 'listPages', {}),
      call(6, 'initLocalWiki', {}),
      call(7, 'listPages', {}),
    ], empty);
    const created = existsSync(path.join(empty, 'nimbalyst-local', 'wiki', 'Home.md'));
    rmSync(empty, { recursive: true, force: true });

    expect(code).toBe(0);
    // Every stdout line is a JSON-RPC response: logging went to stderr.
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'nimbalyst-local', version: expect.any(String) },
          instructions: LOCAL_SERVER_INSTRUCTIONS,
        },
      },
      { jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: expect.stringContaining('Call `initLocalWiki`') }], isError: true } },
      { jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: expect.stringContaining('"created":true') }] } },
      { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: expect.stringContaining('"title":"Home"') }] } },
    ]);
    // The agent made the wiki itself; no `nim wiki init` step for the user.
    expect(created).toBe(true);
    // The list is stable without a wiki, and every name but the local-only ones is a contract name.
    const names = responses[1].result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['initLocalWiki', 'useLocalWiki', ...LOCAL_TOOLS, 'convertTypeStorage', 'pagesForFiles', 'wikiDoctor', 'listMarks', ...EDITOR_TOOLS, 'openWikiInBrowser', 'teamSignIn', 'moveLocalWikiToTeam', 'publishLocalWikiToTeam', 'listPublishedComments', 'diffPublishedPage', 'openUrl']);
    expect(LOCAL_TOOLS.every((n: string) => (PAGE_TOOL_NAMES as readonly string[]).includes(n))).toBe(true);
    // createSharedDoc makes editor pages locally, so it must not inherit the remote server's markdown-only wording.
    const createDoc = responses[1].result.tools.find((t: { name: string }) => t.name === 'createSharedDoc');
    expect(createDoc.inputSchema.properties.documentType.description).not.toContain("Only 'markdown'");
    expect(createDoc.inputSchema.properties.documentType.enum).toEqual(expect.arrayContaining(['markdown', 'excalidraw', 'csv', 'calc.md', 'canvas']));
    expect(createDoc.inputSchema.properties.initialContent.description).not.toMatch(/^Markdown body/);
    expect(stderr).toContain('nim mcp');
  });

  it('edits pages and typed pages in a local wiki, and refuses team scope', async () => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-mcp-wiki-')));
    try {
      const dir = path.join(project, 'nimbalyst-local', 'wiki');
      mkdirSync(path.join(project, '.nimbalyst', 'trackers'), { recursive: true });
      writeFileSync(
        path.join(project, '.nimbalyst', 'trackers', 'competitor.yaml'),
        'type: competitor\ndisplayName: Competitor\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: status\n    type: select\n  - name: activity\n    type: select\n',
      );
      writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'partner.yaml'), 'type: partner\ndisplayNamePlural: Partners\nstorage: table # one CSV\nfields:\n  - name: tier\n    type: select\n');
      await initWiki(dir);
      const wiki = await openWiki(dir);
      const home = (await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, body: 'Welcome.\n' })).id!;
      // A type without `storage:` keeps its items in the app database; an existing page of it stays editable.
      writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'github-pr.yaml'), 'type: github-pr\ndisplayName: Pull request\n');
      const pr = (await wiki.command({ type: 'register-document', title: 'PR 1', parentFolderId: null, pageType: 'github-pr' })).id!;
      writeFileSync(path.join(dir, 'Partners.csv'), 'id,title,tier\nP1,Globex,gold\n');
      wiki.close();

      const { stdout, code } = await runNimMcp([
        call(1, 'createSharedDoc', { title: 'Flags', parentFolderId: home, initialContent: 'We store flags in YAML.\n' }),
        call(2, 'applyCollabDocEdit', { filePath: 'Home/Flags.md', replacements: [{ oldText: 'YAML', newText: 'JSON' }] }),
        call(3, 'searchPages', { query: 'json' }),
        call(4, 'tracker_create', { type: 'competitor', title: 'Acme', status: 'active', description: 'A rival.\n' }),
        call(5, 'tracker_list', { type: 'competitor' }),
        call(6, 'listPages', { section: 'team' }),
        call(7, 'tracker_get', { id: 'NIM-12' }),
        call(8, 'tracker_create', { type: 'bug', title: 'Nope' }),
        call(9, 'tracker_create', { type: 'github-pr', title: 'PR 2' }),
        call(10, 'tracker_update', { id: pr, status: 'merged' }),
        call(11, 'createSharedDoc', { title: 'Flow', documentType: 'excalidraw', initialContent: '{"elements":[]}' }),
        call(12, 'applyCollabDocEdit', { filePath: 'Flow.excalidraw', replacements: [{ oldText: '[]', newText: '[1]' }] }),
        call(13, 'readCollabDoc', { filePath: 'Flow' }),
        call(14, 'tracker_list_types', {}),
        call(15, 'convertTypeStorage', { type: 'partner', storage: 'pages' }),
        call(16, 'tracker_get', { id: 'P1' }),
      ], project);
      expect(code).toBe(0);
      const results = stdout.trim().split('\n').map((line) => JSON.parse(line).result);
      const body = (i: number) => JSON.parse(results[i].content[0].text);

      expect(body(0)).toMatchObject({ path: 'Home/Flags.md', uri: expect.stringMatching(/^local-wiki:\/\//) });
      expect(readFileSync(path.join(dir, 'Home', 'Flags.md'), 'utf8')).toContain('We store flags in JSON.');
      expect(body(2).results.map((r: { title: string }) => r.title)).toEqual(['Flags']);
      expect(readFileSync(path.join(dir, 'Acme.md'), 'utf8')).toMatch(/type: competitor[\s\S]*status: active[\s\S]*A rival\./);
      expect(body(4).items.map((i: { title: string; status: string }) => [i.title, i.status])).toEqual([['Acme', 'active']]);
      for (const i of [5, 6]) {
        expect(results[i].isError).toBe(true);
        expect(results[i].content[0].text).toContain('on the `nimbalyst-team` server');
      }
      expect(results[7].isError).toBe(true);
      expect(results[7].content[0].text).toContain('"bug" is not a wiki type');
      expect(results[8].isError).toBe(true);
      expect(results[8].content[0].text).toContain('"github-pr" items live in the Nimbalyst app database');
      expect(results[8].content[0].text).toContain('storage: pages');
      expect(body(9)).toMatchObject({ id: pr, type: 'github-pr', status: 'merged' });
      // A drawing is its own file; its body is the raw file text.
      expect(body(10)).toMatchObject({ path: 'Flow.excalidraw' });
      expect(body(12)).toMatchObject({ documentType: 'excalidraw', markdown: '{"elements":[1]}' });
      expect(readFileSync(path.join(dir, 'Flow.excalidraw'), 'utf8')).toBe('{"elements":[1]}');
      // A field name the record model keeps for itself is called out where an agent checks its types.
      expect(body(13).types.find((t: { type: string }) => t.type === 'competitor').problems).toEqual([expect.stringContaining('"activity"')]);
      expect(body(14)).toMatchObject({ type: 'partner', storage: 'pages', converted: ['P1'] });
      expect(body(15)).toMatchObject({ id: 'P1', title: 'Globex', storage: 'pages', path: 'Globex.md' });
      expect(readFileSync(path.join(project, '.nimbalyst', 'trackers', 'partner.yaml'), 'utf8')).toContain('storage: pages # one CSV');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('tool calls', () => {
  const info = { name: 'nimbalyst-local', version: 'test' };
  const tools = new ToolMap()
    .register({
      definition: { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } },
      call: async (args) => textResult(args),
    })
    .register({
      definition: { name: 'tracker_update', description: 'Update.', inputSchema: { type: 'object', properties: {} } },
      call: async () => {
        throw new TeamScopeRefusal('tracker_update');
      },
    });

  it('runs a registered tool, refuses team scope by naming the remote tool, and rejects unknown tools', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => (written += chunk));
    const done = runStdioServer({ tools, serverInfo: info, input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tracker_update', arguments: {} } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })}\n`);
    input.end();
    await done;

    const [echo, refused, unknown] = written.trim().split('\n').map((line) => JSON.parse(line));
    expect(echo.result).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain('Call `tracker_update` on the `nimbalyst-team` server');
    expect(unknown.error).toEqual({ code: -32602, message: 'Unknown tool: nope' });
  });

  it('rejects a message that is not a request object', async () => {
    expect(await handleMessage([1, 2], tools, info)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request' },
    });
  });
});

describe('re-pointing the server at another project', () => {
  const projects: string[] = [];
  const project = async (withWiki: boolean) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-mcp-repoint-')));
    projects.push(dir);
    if (withWiki) await initWiki(path.join(dir, 'nimbalyst-local', 'wiki'));
    return dir;
  };
  afterAll(() => {
    for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  });
  const run = async (tools: ToolMap, name: string, args: Record<string, unknown> = {}) => {
    const result = await tools.get(name)!.call(args);
    return { isError: result.isError === true, text: result.content[0].text, body: () => JSON.parse(result.content[0].text) };
  };

  it('useLocalWiki moves every later call to the named project or wiki folder, and names the folder in each result', async () => {
    const a = await project(true);
    const b = await project(true);
    const empty = await project(false);
    const wikiA = path.join(a, 'nimbalyst-local', 'wiki');
    const wikiB = path.join(b, 'nimbalyst-local', 'wiki');
    const tools = createLocalToolMap(localWikiContext(a));

    expect((await run(tools, 'listPages')).body().wikiFolder).toBe(wikiA);
    expect((await run(tools, 'useLocalWiki', { folder: b })).body()).toEqual({ projectRoot: b, wikiFolder: wikiB });
    expect((await run(tools, 'listPages')).body().wikiFolder).toBe(wikiB);
    const created = await run(tools, 'createSharedDoc', { title: 'Moved' });
    expect(created.body()).toMatchObject({ wikiFolder: wikiB, path: 'Moved.md' });
    expect(existsSync(path.join(wikiB, 'Moved.md'))).toBe(true);
    expect(existsSync(path.join(wikiA, 'Moved.md'))).toBe(false);

    // A wiki folder itself works too, and resolves to its project.
    expect((await run(tools, 'useLocalWiki', { folder: wikiA })).body()).toEqual({ projectRoot: a, wikiFolder: wikiA });
    expect((await run(tools, 'tracker_list_types')).body().wikiFolder).toBe(wikiA);

    // A folder that does not exist changes nothing.
    const missing = await run(tools, 'useLocalWiki', { folder: path.join(a, 'nope') });
    expect(missing.isError).toBe(true);
    expect((await run(tools, 'listPages')).body().wikiFolder).toBe(wikiA);

    // A project without a wiki: pointed there, told to create one, and initLocalWiki creates it there.
    const none = await run(tools, 'useLocalWiki', { folder: empty });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('initLocalWiki');
    expect(none.text).toContain(path.join(empty, 'nimbalyst-local', 'wiki'));
    expect((await run(tools, 'initLocalWiki')).body().dir).toBe(path.join(empty, 'nimbalyst-local', 'wiki'));
  });

  it('useLocalWiki on a wiki folder that is its own git repository makes that folder the project', async () => {
    const outer = await project(true);
    const wiki = path.join(outer, 'nimbalyst-local', 'wiki');
    execFileSync('git', ['init', '-q'], { cwd: wiki, stdio: 'ignore' });
    // Sandboxed: the repository is the temp wiki folder, never this checkout.
    expect(realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: wiki, encoding: 'utf8' }).trim())).toBe(wiki);
    const tools = createLocalToolMap(localWikiContext(await project(true)));

    expect((await run(tools, 'useLocalWiki', { folder: wiki })).body()).toEqual({ projectRoot: wiki, wikiFolder: wiki });
  });

  it('pagesForFiles names the pages whose paths cover the given files, and which clock dated them', async () => {
    const dir = await project(true);
    writeFileSync(path.join(dir, 'nimbalyst-local', 'wiki', 'Sync.md'), '---\nid: page-sync\npaths: [src/sync/**]\n---\n\nBody.\n');
    const tools = createLocalToolMap(localWikiContext(dir));
    const result = (await run(tools, 'pagesForFiles', { files: ['src/sync/a.ts', 'README.md'] })).body();
    expect(result).toMatchObject({ wikiFolder: path.join(dir, 'nimbalyst-local', 'wiki'), source: 'given' });
    // Outside git there is no commit to compare, so nothing is stale and the page is dated by mtime.
    expect(result.pages).toEqual([expect.objectContaining({ id: 'page-sync', title: 'Sync', files: ['src/sync/a.ts'], stale: false, clock: 'mtime' })]);
    const none = await run(createLocalToolMap(localWikiContext(await project(false))), 'pagesForFiles', {});
    expect(none.isError).toBe(true);
    expect(none.text).toContain('initLocalWiki');
  });

  it('setPageFields records the globs a page covers in paths, and ignores a value that is not a list of globs', async () => {
    const dir = await project(true);
    const tools = createLocalToolMap(localWikiContext(dir));
    const page = (await run(tools, 'createSharedDoc', { title: 'Sync' })).body();
    const set = (await run(tools, 'setPageFields', { itemId: page.itemId ?? page.documentId, fields: { paths: ['src/sync/**', 'packages/sync'] } })).body();
    expect(set.fields.paths).toEqual(['src/sync/**', 'packages/sync']);
    expect(readFileSync(path.join(dir, 'nimbalyst-local', 'wiki', 'Sync.md'), 'utf8')).toContain('src/sync/**');
    const bad = (await run(tools, 'setPageFields', { itemId: set.itemId, fields: { paths: 'src/**' } })).body();
    expect(bad.ignored).toEqual(['paths']);
    expect(bad.fields.paths).toEqual(['src/sync/**', 'packages/sync']);
    // The model only sends what the schema shows it; the shared contract has no paths.
    const schema = tools.definitions().find((t) => t.name === 'setPageFields')!.inputSchema.properties.fields as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['owner', 'status', 'summary', 'tags', 'paths']);
    expect(Object.keys((pageToolContract('setPageFields')!.inputSchema.properties.fields as { properties: object }).properties)).not.toContain('paths');
  });

  it('wikiDoctor and listMarks answer over the local wiki, and ask for initLocalWiki without one', async () => {
    const dir = await project(true);
    const wikiDir = path.join(dir, 'nimbalyst-local', 'wiki');
    writeFileSync(path.join(wikiDir, 'Storage.md'), '---\nid: page-storage\n---\n\n[Use SQLite.]{decided by=Dana on=2026-10-01 over=Postgres} [Backups?]{open}\n');
    const tools = createLocalToolMap(localWikiContext(dir));
    const doctor = (await run(tools, 'wikiDoctor', {})).body();
    expect(doctor).toMatchObject({ wikiFolder: wikiDir, summary: { orphans: 1 } });
    expect(doctor.orphans.pages).toEqual([expect.objectContaining({ id: 'page-storage' })]);
    const marks = (await run(tools, 'listMarks', { kind: 'decided' })).body();
    // `line` counts in the body readCollabDoc returns, not the file with its frontmatter.
    expect(marks.marks).toEqual([{ pageId: 'page-storage', title: 'Storage', line: 2, kind: 'decided', by: 'Dana', on: '2026-10-01', over: 'Postgres', text: 'Use SQLite.' }]);
    writeMigratedTo(dir, { orgId: 'org-1', projectId: 'proj-1', at: '2026-10-15T00:00:00.000Z' });
    const archived = (await run(tools, 'listMarks', {})).body();
    expect(archived.movedToTeam).toMatchObject({ orgId: 'org-1', projectId: 'proj-1', note: expect.stringContaining('archive') });
    const none = await run(createLocalToolMap(localWikiContext(await project(false))), 'listMarks', {});
    expect(none.isError).toBe(true);
    expect(none.text).toContain('initLocalWiki');
  });

  it('rewords contract arguments that mean something else on a local wiki', () => {
    const tools = createLocalToolMap(localWikiContext(tmpdir()));
    const descriptions = tools
      .definitions()
      .filter((t) => (PAGE_TOOL_NAMES as readonly string[]).includes(t.name) && !t.name.startsWith('tracker_'))
      .flatMap((t) => Object.entries(t.inputSchema.properties).map(([key, value]) => [`${t.name}.${key}`, (value as { description?: string }).description ?? '']));
    // Local typed pages have ids, never issue keys, and the wiki has no sections or projects.
    expect(descriptions.filter(([, text]) => /issue key|top of the (section|project)/.test(text))).toEqual([]);
    const parent = tools.definitions().find((t) => t.name === 'createSharedDoc')!.inputSchema.properties.parentFolderId as { description: string };
    expect(parent.description).toBe('Parent page id, or typed page id. Omit for the top of the wiki.');
  });

  it('sends the instructions it was given in initialize, and none when given none', async () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    const info = { name: 'nimbalyst-local', version: 'test' };
    const bare = (await handleMessage(initialize, new ToolMap(), info)) as { result: Record<string, unknown> };
    expect(bare.result).not.toHaveProperty('instructions');
    const given = (await handleMessage(initialize, new ToolMap(), info, undefined, 'Read the wiki.')) as { result: { instructions: string } };
    expect(given.result.instructions).toBe('Read the wiki.');
  });

  it('the local server tells the agent to consult the wiki before changes and to check covered pages after them', () => {
    // Static text: the server answers initialize without touching the disk.
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('`update` skill');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('useLocalWiki');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('searchPages');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('pagesForFiles');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('`capture` skill');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('listMarks');
  });

  it('the local server steers the agent to its own tools, not a separately installed `nim` on PATH', () => {
    // A user on plugin 0.11.0 had an agent read `nim --version` from an older global install and report the wrong version.
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('`openWikiInBrowser`');
    expect(LOCAL_SERVER_INSTRUCTIONS).toContain('`wikiDoctor`');
    expect(LOCAL_SERVER_INSTRUCTIONS).toMatch(/`nim` command on the shell's PATH is a separate install/);
  });
});

describe('plugin workspace', () => {
  const pluginRoot = '/home/u/.codex/plugins/cache/nimbalyst/nimbalyst-wiki/0.3.0';

  it('uses Claude Code project, else Codex PWD only when started in the plugin directory', () => {
    expect(resolvePluginWorkspace({ CLAUDE_PROJECT_DIR: '/repo', PWD: '/other' }, pluginRoot, pluginRoot)).toBe('/repo');
    expect(resolvePluginWorkspace({ PWD: '/repo' }, `${pluginRoot}/`, pluginRoot)).toBe('/repo');
    // A host that moved the cwd without updating PWD: the cwd wins.
    expect(resolvePluginWorkspace({ PWD: '/stale' }, '/repo', pluginRoot)).toBe('/repo');
    expect(resolvePluginWorkspace({}, pluginRoot, pluginRoot)).toBe(pluginRoot);
  });
});

describe('plugin update check', () => {
  const install: PluginInstall = {
    kind: 'plugin',
    agent: 'claude',
    marketplace: 'nimbalyst',
    version: '0.5.0',
    url: 'https://example.test/plugin.json',
  };
  const cachedAs = (latestVersion: string | null, checkedAt: number, ok = true) => ({ [install.url]: { checkedAt, latestVersion, ok } });
  const manifestFetch = (version: string) => (async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

  it('appends the notice once, to the first successful tool result after a newer version is fetched, and caches it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-update-'));
    try {
      const cacheFile = path.join(dir, 'nested', 'update-check.json');
      const check = startUpdateCheck({ install, env: {}, cacheFile, now: () => 1000, fetchImpl: manifestFetch('0.6.0'), log: () => {} });
      await check.settled;
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(cachedAs('0.6.0', 1000));

      const tools = new ToolMap()
        .register({ definition: { name: 'ok', description: 'Ok.', inputSchema: { type: 'object', properties: {} } }, call: async () => textResult('done') })
        .register({ definition: { name: 'bad', description: 'Bad.', inputSchema: { type: 'object', properties: {} } }, call: async () => textResult('no', true) });
      const info = { name: 'nimbalyst-local', version: 'test' };
      const call = (id: number, name: string) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }, tools, info, check.takeNotice) as Promise<any>;

      expect((await call(1, 'bad')).result.content).toHaveLength(1);
      const first = (await call(2, 'ok')).result.content;
      expect(first).toHaveLength(2);
      expect(first[1].text).toContain('Nimbalyst Wiki 0.6.0 is available (installed: 0.5.0)');
      expect(first[1].text).toContain('`claude plugin update nimbalyst-wiki@nimbalyst`');
      expect((await call(3, 'ok')).result.content).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a fresh cache without fetching, refetches a stale one, and stays quiet when opted out, in CI or offline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-update-'));
    try {
      const cacheFile = path.join(dir, 'update-check.json');
      const day = 24 * 60 * 60 * 1000;
      writeFileSync(cacheFile, JSON.stringify(cachedAs('0.7.0', 0)));
      const failFetch = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;

      let fetched = false;
      const noFetch = (async () => {
        fetched = true;
        return new Response('{}');
      }) as unknown as typeof fetch;
      const fresh = startUpdateCheck({ install, env: {}, cacheFile, now: () => day - 1, fetchImpl: noFetch, log: () => {} });
      await fresh.settled;
      expect(fetched).toBe(false);
      expect(fresh.takeNotice()).toContain('Nimbalyst Wiki 0.7.0');

      const optedOut = startUpdateCheck({ install, env: { NIMBALYST_WIKI_NO_UPDATE_CHECK: '1' }, cacheFile, now: () => 2 * day, fetchImpl: noFetch });
      await optedOut.settled;
      expect(fetched).toBe(false);
      expect(optedOut.takeNotice()).toBeNull();
      const inCi = startUpdateCheck({ install, env: { CI: 'true' }, cacheFile, now: () => 2 * day, fetchImpl: noFetch });
      await inCi.settled;
      expect(fetched).toBe(false);
      expect(inCi.takeNotice()).toBeNull();

      // Offline with a stale cache: the cached version still counts, and the failure is recorded
      // so the next start an hour later retries instead of every start.
      const logs: string[] = [];
      const offline = startUpdateCheck({ install, env: {}, cacheFile, now: () => 2 * day, fetchImpl: failFetch, log: (line) => logs.push(line) });
      await offline.settled;
      expect(logs[0]).toContain('offline');
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(cachedAs('0.7.0', 2 * day, false));
      expect(offline.takeNotice()).toContain('0.7.0');
      const soonAfter = startUpdateCheck({ install, env: {}, cacheFile, now: () => 2 * day + 1000, fetchImpl: noFetch, log: () => {} });
      await soonAfter.settled;
      expect(fetched).toBe(false);

      // An hour after the failure the fetch runs again; the same version as installed is no notice.
      const current = startUpdateCheck({ install, env: {}, cacheFile, now: () => 2 * day + 60 * 60 * 1000, fetchImpl: manifestFetch('0.5.0'), log: () => {} });
      await current.settled;
      expect(current.takeNotice()).toBeNull();
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))[install.url].latestVersion).toBe('0.5.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects which agent and marketplace installed the plugin, and skips anything else', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'nim-install-'));
    try {
      const codexRoot = path.join(home, '.codex/plugins/cache/nimbalyst-wiki/nimbalyst-wiki/0.5.0');
      const claudeRoot = path.join(home, '.claude/plugins/cache/nimbalyst/nimbalyst-wiki/0.5.0');
      const otherRoot = path.join(home, '.claude/plugins/cache/someone-else/nimbalyst-wiki/0.5.0');
      for (const root of [codexRoot, claudeRoot, otherRoot]) {
        for (const dirName of ['.claude-plugin', '.codex-plugin']) {
          mkdirSync(path.join(root, dirName), { recursive: true });
          writeFileSync(path.join(root, dirName, 'plugin.json'), JSON.stringify({ version: '0.5.0' }));
        }
      }

      const codex = detectPluginInstall({ PWD: '/repo' }, codexRoot, codexRoot);
      expect(codex).toMatchObject({ agent: 'codex', marketplace: 'nimbalyst-wiki', version: '0.5.0' });
      expect(codex?.url).toContain('nimbalyst-wiki/main/.codex-plugin/plugin.json');
      // The `nimbalyst` marketplace installs from the generated mirror too, so it reads the mirror's manifest.
      const claude = detectPluginInstall({ CLAUDE_PROJECT_DIR: '/repo' }, '/repo', claudeRoot);
      expect(claude).toMatchObject({ agent: 'claude', marketplace: 'nimbalyst' });
      expect(claude?.url).toBe('https://raw.githubusercontent.com/nimbalyst/nimbalyst-wiki/main/.claude-plugin/plugin.json');

      expect(detectPluginInstall({}, '/repo', otherRoot)).toBeNull();
      expect(detectPluginInstall({}, '/repo', path.join(repoRoot, 'plugins/nimbalyst-wiki'))).toBeNull();

      // `nim mcp` as each agent's plugin config starts it through npx, in the project: Claude Code
      // passes the plugin root; Codex can't, so its install is found under the CLI's own version.
      const machine = (env: NodeJS.ProcessEnv) => ({ env, home });
      expect(pluginServerSetup(machine({ CLAUDE_PROJECT_DIR: '/repo' }), '/repo', { root: claudeRoot }, '0.5.0')).toEqual({ workspace: '/repo', install: claude });
      expect(pluginServerSetup(machine({ CLAUDE_PROJECT_DIR: '/repo' }), '/repo', { root: otherRoot }, '0.5.0').install).toEqual({ kind: 'unmanaged', reason: 'checkout' });
      expect(pluginServerSetup(machine({ PWD: '/npx/clobbered' }), '/repo', { agent: 'codex' }, '0.5.0')).toEqual({ workspace: '/repo', install: { ...codex, agent: 'codex' } });
      expect(pluginServerSetup(machine({}), '/repo', { agent: 'codex' }, '0.6.0').install).toEqual({ kind: 'unmanaged', reason: 'checkout' });

      const notice = startUpdateCheck({ install: { ...codex!, version: '0.4.0' }, env: {}, cacheFile: path.join(home, 'c.json'), now: () => 0, fetchImpl: manifestFetch('0.5.0'), log: () => {} });
      await notice.settled;
      expect(notice.takeNotice()).toContain('run `codex plugin marketplace upgrade nimbalyst-wiki`, then start a new session');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('classifies the npm or pnpm install a running nim belongs to, and what npm cannot update', () => {
    const bin = (...parts: string[]) => path.join(path.sep, ...parts, 'node_modules', '@nimbalyst', 'cli', 'dist', 'bin', 'cli.js');
    expect(detectNpmInstall(bin('usr', 'local', 'lib'), '0.9.0')).toMatchObject({
      kind: 'npm',
      manager: 'npm',
      global: true,
      packageDir: path.join(path.sep, 'usr', 'local', 'lib', 'node_modules', '@nimbalyst', 'cli'),
      url: 'https://registry.npmjs.org/@nimbalyst/cli/latest',
    });
    expect(detectNpmInstall(bin('home', 'me', 'Library', 'pnpm', 'global', '5', 'node_modules', '.pnpm', '@nimbalyst+cli@0.9.0'), '0.9.0')).toMatchObject({ manager: 'pnpm', global: true });
    expect(detectNpmInstall(bin('work', 'app'), '0.9.0')).toMatchObject({ manager: 'npm', global: false });
    expect(detectNpmInstall(bin('home', 'me', '.npm', '_npx', 'abc123'), '0.9.0')).toEqual({ kind: 'unmanaged', reason: 'npx' });
    expect(detectNpmInstall(path.join(packageDir, 'dist', 'bin', 'cli.js'), '0.9.0')).toEqual({ kind: 'unmanaged', reason: 'checkout' });
    expect(detectNpmInstall(path.join(path.sep, 'Applications', 'Nimbalyst.app', 'Contents', 'Resources', 'nim', 'dist', 'bin', 'cli-bundled.js'), '0.9.0')).toEqual({ kind: 'unmanaged', reason: 'app' });
  });
});
