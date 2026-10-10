// @vitest-environment node
/**
 * `nim wiki` over a local wiki folder, end to end through `main()` in a temp
 * git checkout, and the compatibility contract: a wiki written by
 * `@nimbalyst/local-wiki` directly (as the desktop app does) loads through `nim`
 * with no file changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initWiki, openWiki } from '@nimbalyst/local-wiki';
import { main } from '../../index.js';
import { parseArgs } from '../../cli/parse.js';
import { isLocalWikiCall } from '../wikiLocal.js';
import { runLocalTracker } from '../trackerLocal.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-wiki-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function nim(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  try {
    const code = await main(['--no-color', ...argv]);
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function snapshotFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(root, abs)] = readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('nim wiki over a local folder', () => {
  it('inits, writes with a version check, lists, reads, moves and searches', async () => {
    const repo = scratch();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // Guard: every git command below must act on the sandbox, not this checkout.
    expect(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(repo);
    const ws = ['--workspace', repo];

    const init = await nim('wiki', 'init', ...ws, '--json');
    expect(init.code).toBe(0);
    const wikiDir = path.join(repo, 'nimbalyst-local', 'wiki');
    expect(JSON.parse(init.out)).toMatchObject({ dir: wikiDir, created: true, gitignoreUpdated: true });
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('nimbalyst-local/\n');
    expect(JSON.parse(readFileSync(path.join(repo, '.nimbalyst', 'local-wiki.json'), 'utf8'))).toEqual({ location: 'nimbalyst-local/wiki' });
    // Again: nothing new, .gitignore untouched.
    expect(JSON.parse((await nim('wiki', 'init', ...ws, '--json')).out)).toMatchObject({ created: false, homeId: null, gitignoreUpdated: false });

    const bodyFile = path.join(repo, 'notes.md');
    writeFileSync(bodyFile, 'First draft about flags.\n');
    expect((await nim('wiki', 'write', 'Notes', '--file', bodyFile, ...ws)).code).toBe(1); // no --create: not found
    expect((await nim('wiki', 'write', 'Notes', '--create', '--file', bodyFile, ...ws)).code).toBe(0);

    const tree = JSON.parse((await nim('wiki', 'ls', '--json', ...ws)).out);
    expect(tree.map((n: { title: string; depth: number }) => [n.title, n.depth])).toEqual([
      ['Home', 0],
      ['Notes', 0],
    ]);

    const read = JSON.parse((await nim('wiki', 'read', 'Notes', '--json', ...ws)).out);
    expect(read.markdown).toBe('First draft about flags.\n');
    writeFileSync(bodyFile, 'Second draft about flags.\n');
    expect((await nim('wiki', 'write', read.id, '--file', bodyFile, '--expected-version', read.version, ...ws)).code).toBe(0);
    // The first version is stale now: refused, nothing written.
    writeFileSync(bodyFile, 'Lost update.\n');
    const stale = await nim('wiki', 'write', read.id, '--file', bodyFile, '--expected-version', read.version, ...ws);
    expect(stale.code).toBe(7);
    expect(stale.err).toContain('nothing was written');

    expect((await nim('wiki', 'move', 'Notes', '--parent', 'Home', '--title', 'Flag notes', ...ws)).code).toBe(0);
    expect(readFileSync(path.join(wikiDir, 'Home', 'Flag notes.md'), 'utf8')).toContain('Second draft about flags.');
    expect((await nim('wiki', 'read', 'Home/Flag notes.md', ...ws)).out).toBe('Second draft about flags.\n');

    const hits = JSON.parse((await nim('wiki', 'search', 'draft', 'flags', '--json', ...ws)).out);
    expect(hits.map((h: { id: string }) => h.id)).toEqual([read.id]);
  });

  it('routes one noun to the local or team wiki, with --team and --local to force it', async () => {
    const repo = scratch();
    vi.stubEnv('NIM_CONFIG_DIR', path.join(repo, 'config')); // signed out
    vi.stubEnv('NIM_SERVER', 'https://sync.test');
    const route = (...argv: string[]) => isLocalWikiCall(parseArgs(['wiki', ...argv, '--workspace', repo]));

    // Neither wiki reachable: say how to get each.
    const none = await nim('wiki', 'list', '--workspace', repo);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/nim wiki init.*nim login/);
    expect(route('status')).toBe(false);
    expect(() => route('list', '--team', '--local')).toThrow(/not both/);
    expect(() => route('edit', 'x', '--local')).toThrow(/is for the team wiki/);
    expect(() => route('write', 'x', '--team')).toThrow(/use 'nim wiki edit'/);

    expect((await nim('wiki', 'init', '--workspace', repo)).code).toBe(0);
    for (const verb of ['list', 'ls', 'read', 'search']) expect(route(verb, 'Home')).toBe(true);
    expect(route('read', 'collab://org:o1:doc:home')).toBe(false);
    expect(route('list', '--org', 'o1', '--project', 'p1')).toBe(false);
    expect(route('list', '--team')).toBe(false);
    expect(route('items')).toBe(false);
  });

  it('loads a wiki written by the library unchanged', async () => {
    const root = scratch();
    const dir = path.join(root, 'docs', 'wiki');
    await initWiki(dir);
    const wiki = await openWiki(dir);
    const home = (await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, body: 'Start here.\n' })).id!;
    await wiki.command({ type: 'register-document', title: 'R/D: plans?', parentFolderId: home, body: 'Odd title.\n', fields: { status: 'draft' } });
    await wiki.command({ type: 'register-document', title: 'Acme', parentFolderId: null, pageType: 'competitor', fields: { tier: 'a' } });
    await wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{"elements":[]}' });
    wiki.close();
    const before = snapshotFiles(dir);

    const ls = await nim('wiki', 'ls', '--json', '--location', dir, '--workspace', root);
    expect(ls.code).toBe(0);
    expect(JSON.parse(ls.out).map((n: { title: string; kind: string; documentType?: string }) => [n.title, n.kind, n.documentType])).toEqual([
      ['Home', 'page', undefined],
      ['R/D: plans?', 'page', undefined],
      ['Acme', 'typedPage', undefined],
      ['Flow', 'page', 'excalidraw'],
    ]);
    expect((await nim('wiki', 'ls', '--location', dir, '--workspace', root)).out).toMatch(/^Flow {2}excalidraw {2}[0-9A-Z]{26}$/m);
    expect((await nim('wiki', 'read', 'R/D: plans?', '--location', dir, '--workspace', root)).out).toBe('Odd title.\n');
    const drawing = JSON.parse((await nim('wiki', 'read', 'Flow.excalidraw', '--json', '--location', dir, '--workspace', root)).out);
    expect(drawing).toMatchObject({ title: 'Flow', documentType: 'excalidraw', markdown: '{"elements":[]}' });
    expect(snapshotFiles(dir)).toEqual(before);

    // A drawing's body is its whole file, written with the same version check.
    const next = path.join(root, 'flow.json');
    writeFileSync(next, '{"elements":[1]}');
    expect((await nim('wiki', 'write', 'Flow', '--file', next, '--expected-version', drawing.version, '--location', dir, '--workspace', root)).code).toBe(0);
    expect(readFileSync(path.join(dir, 'Flow.excalidraw'), 'utf8')).toBe('{"elements":[1]}');
    expect((await nim('wiki', 'write', 'Flow', '--file', next, '--expected-version', drawing.version, '--location', dir, '--workspace', root)).code).toBe(7);
  });

  it('serves nim tracker for types placed in the wiki and leaves other types to the database', async () => {
    const project = scratch();
    mkdirSync(path.join(project, '.nimbalyst', 'trackers'), { recursive: true });
    writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'competitor.yaml'), 'type: competitor\ndisplayName: Competitor\nstorage: pages\n');
    writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'customer.yaml'), 'type: customer\ndisplayName: Customer\n');
    const ws = ['--workspace', project];
    expect((await nim('wiki', 'init', ...ws)).code).toBe(0);

    // A type without `storage:` stays with the database, even to create.
    expect(await runLocalTracker(parseArgs(['tracker', 'create', 'customer', 'Initech', ...ws]))).toBeNull();
    // A declared wiki type is routed from its first item, without --local.
    const created = await nim('tracker', 'create', 'competitor', 'Acme', '--status', 'active', '--body', 'A rival.', '--json', ...ws);
    expect(created.code).toBe(0);
    const id = JSON.parse(created.out).id;
    expect(readFileSync(path.join(project, 'nimbalyst-local', 'wiki', 'Acme.md'), 'utf8')).toMatch(/type: competitor[\s\S]*status: active[\s\S]*A rival\./);

    expect((await nim('tracker', 'update', id, '--status', 'defunct', '--field', 'tier=a', ...ws)).code).toBe(0);
    const listed = JSON.parse((await nim('tracker', 'list', '--type', 'competitor', '--json', ...ws)).out);
    expect(listed.map((i: { title: string; status: string; fields: { tier: string } }) => [i.title, i.status, i.fields.tier])).toEqual([['Acme', 'defunct', 'a']]);
    expect(JSON.parse((await nim('tracker', 'get', id, '--json', ...ws)).out).markdown).toContain('A rival.');

    // Types and references the wiki does not hold go to the database gateways.
    expect(await runLocalTracker(parseArgs(['tracker', 'list', '--type', 'bug', ...ws]))).toBeNull();
    expect(await runLocalTracker(parseArgs(['tracker', 'get', 'NIM-12', ...ws]))).toBeNull();
    expect(await runLocalTracker(parseArgs(['tracker', 'list', ...ws]))).toBeNull();
  });
});
