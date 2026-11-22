// @vitest-environment node
/**
 * The SessionStart context: what an agent is told about the local wiki before
 * its first prompt. Nothing without a wiki, never more than the cap. And the
 * plugin's two hooks as `nim hook` runs them.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeMigratedTo } from '../../localWiki/locate.js';
import { initLocalWiki } from '../../localWiki/open.js';
import { buildWikiContext, CONTEXT_MAX_CHARS } from '../wikiContext.js';
import { coveredPages } from '../pluginHooks.js';
import { runHook } from '../../commands/hook.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; wiki: string }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-context-')));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  // Sandboxed: git runs in the temp repository, never this checkout.
  expect(realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim())).toBe(root);
  (await initLocalWiki(root)).wiki.close();
  const wiki = path.join(root, 'nimbalyst-local', 'wiki');
  return { root, wiki };
}

function page(wiki: string, name: string, frontmatter: string, body = 'Body.\n'): void {
  writeFileSync(path.join(wiki, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

describe('buildWikiContext', () => {
  it('is null for a project with no local wiki', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-context-none-')));
    dirs.push(root);
    expect(await buildWikiContext(root)).toBeNull();
  });

  it('names the folder, Home, top-level pages, open questions and the pages covering current changes', async () => {
    const { root, wiki } = await project();
    const home = readdirSync(wiki).find((name) => name === 'Home.md');
    expect(home).toBe('Home.md');
    page(wiki, 'Home', 'id: home\nsummary: Where the widget project keeps its decisions.');
    page(wiki, 'Sync protocol', 'id: sync\nsummary: How clients sync.\npaths: [src/sync/**]', '[Do we batch acks?]{open by="Spike 2"}\n\nAnd [retries]{open}.\n\n`[not]{open}` in code.\n');
    page(wiki, 'Glossary', 'id: glossary');
    mkdirSync(path.join(root, 'src', 'sync'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'sync', 'a.ts'), 'a\n');

    const text = (await buildWikiContext(root))!;
    expect(text).toContain('nimbalyst-local/wiki');
    expect(text).toContain('Home: Where the widget project keeps its decisions.');
    expect(text).toContain('- Sync protocol: How clients sync.');
    expect(text).toContain('- Glossary');
    expect(text).toContain('2 open questions');
    expect(text).toMatch(/cover files changed in the working tree: Sync protocol/);
    expect(text).toContain('/nimbalyst-wiki:capture');
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });

  it('answers within its time bound on a large wiki whose pages all cover the changed files, and gives up past the deadline', { timeout: 60_000 }, async () => {
    const { root, wiki } = await project();
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    for (let i = 0; i < 150; i++) page(wiki, `Area ${String(i).padStart(3, '0')}`, `id: area-${i}\npaths: [src/**]`);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, 'src', `f${i}.ts`), `${i}\n`);
    execFileSync('git', ['add', 'src'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: root });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, 'src', `f${i}.ts`), `${i} changed\n`);

    const started = Date.now();
    const text = (await buildWikiContext(root))!;
    const elapsed = Date.now() - started;
    expect(text).toMatch(/cover files changed in the working tree: Area 000/);
    expect(elapsed).toBeLessThan(3000);
    // Past its deadline the hook says nothing rather than run on.
    expect(await buildWikiContext(root, CONTEXT_MAX_CHARS, { deadline: Date.now() })).toBeNull();
  });

  it('after a move to Teams, points at the team wiki and says nothing about the local archive', async () => {
    const { root, wiki } = await project();
    page(wiki, 'Sync protocol', 'id: sync\npaths: [src/sync/**]');
    mkdirSync(path.join(root, 'src', 'sync'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'sync', 'a.ts'), 'a\n');
    expect(await coveredPages(root)).toEqual([{ title: 'Sync protocol', stale: false }]);
    writeMigratedTo(root, { orgId: 'org-1', projectId: 'proj-1', at: '2026-10-15T00:00:00.000Z' });
    const text = (await buildWikiContext(root))!;
    expect(text).toMatch(/moved to a Nimbalyst Teams project/);
    expect(text).not.toContain('Sync protocol');
    expect(text.split('\n')).toHaveLength(1);
    expect(await coveredPages(root)).toEqual([]);
  });

  it('stays under the cap on a large wiki and says how many pages it left out', async () => {
    const { root, wiki } = await project();
    for (let i = 0; i < 120; i++) page(wiki, `Topic ${String(i).padStart(3, '0')}`, `id: topic-${i}\nsummary: ${'A long summary of this topic. '.repeat(6).trim()}`);
    const text = (await buildWikiContext(root))!;
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(text).toContain('- Topic 000');
    expect(text).toMatch(/and \d+ more top-level pages/);
    expect(text).toContain('/nimbalyst-wiki:capture');
  });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-hook-')));
  dirs.push(root);
  return root;
}

describe('nim hook, the plugin hooks', () => {
  function toolUse(name: string, input: Record<string, unknown>): string {
    return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  }

  async function runNudge(root: string, input: unknown, env: NodeJS.ProcessEnv = {}) {
    const out = await runHook('stop', typeof input === 'string' ? input : JSON.stringify(input), {
      ...process.env,
      NIMBALYST_WIKI_NUDGE_STATE_DIR: path.join(root, 'state'),
      NIMBALYST_WIKI_NUDGE_MIN_EDITS: '3',
      ...env,
    });
    return out ? JSON.parse(out) : null;
  }

  function transcript(root: string, name: string, lines: string[]): string {
    const file = path.join(root, `${name}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }

  it('nudge blocks once per session, and only after substantive work', async () => {
    const root = tempRoot();
    const edits = transcript(root, 'edits', [
      toolUse('Read', { file_path: 'a.ts' }),
      ...['a.ts', 'b.ts', 'c.ts'].map((file) => toolUse('Edit', { file_path: file })),
    ]);
    const first = await runNudge(root, { session_id: 's1', transcript_path: edits, stop_hook_active: false });
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /3 file edits.*\/nimbalyst-wiki:capture.*"nothing to record"/);
    // The reason is shown to the agent and the user as one sentence; joined parts keep their spaces.
    assert.doesNotMatch(first.reason, /\S(?:to record|If nothing)/);
    assert.equal(await runNudge(root, { session_id: 's1', transcript_path: edits }), null);

    // The threshold is overridable, and below it nothing happens.
    assert.equal(await runNudge(root, { session_id: 's2', transcript_path: edits }, { NIMBALYST_WIKI_NUDGE_MIN_EDITS: '4' }), null);

    const commit = transcript(root, 'commit', ['not json', toolUse('Bash', { command: 'git add x && git commit -m "x"' })]);
    assert.match((await runNudge(root, { session_id: 's3', transcript_path: commit })).reason, /1 git commit/);
    const plan = transcript(root, 'plan', [toolUse('Write', { file_path: '/repo/nimbalyst-local/plans/thing.md' })]);
    assert.match((await runNudge(root, { session_id: 's4', transcript_path: plan })).reason, /a plan/);

    // Already recorded through the plugin's Pages tools, or the desktop's: no nudge.
    const writes = [
      'mcp__plugin_nimbalyst-wiki_nimbalyst-team__applyCollabDocEdit',
      'mcp__plugin_nimbalyst-wiki_nimbalyst-team__createSharedDoc',
      'mcp__plugin_nimbalyst-wiki_nimbalyst-team__setPageType',
      'mcp__plugin_nimbalyst-wiki_nimbalyst-team__moveSharedItem',
      'mcp__plugin_nimbalyst-wiki_nimbalyst-team__tracker_create',
      'mcp__nimbalyst-trackers__tracker_update',
    ];
    for (const [i, name] of writes.entries()) {
      const captured = transcript(root, `captured-${i}`, [toolUse('Bash', { command: 'git commit -m x' }), toolUse(name, { id: 'X' })]);
      assert.equal(await runNudge(root, { session_id: `s5-${i}`, transcript_path: captured }), null, name);
    }
    // Reads, and the retired wiki_* names, are not a record.
    for (const name of ['mcp__plugin_nimbalyst-wiki_nimbalyst-team__readCollabDoc', 'mcp__plugin_nimbalyst-wiki_nimbalyst-wiki__wiki_update_item']) {
      const read = transcript(root, `read-${name.length}`, [toolUse('Bash', { command: 'git commit -m x' }), toolUse(name, { id: 'X' })]);
      assert.equal((await runNudge(root, { session_id: `s6-${name.length}`, transcript_path: read })).decision, 'block', name);
    }
  });

  it('nudge stays quiet with no wiki to record into: no git remote and no local wiki', async () => {
    const root = tempRoot();
    const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);
    const noRemote = path.join(root, 'no-remote');
    mkdirSync(noRemote);
    spawnSync('git', ['init', '-q'], { cwd: noRemote });
    assert.equal(await runNudge(root, { session_id: 'r1', transcript_path: commit, cwd: noRemote }), null);
    assert.equal(await runNudge(root, { session_id: 'r2', transcript_path: commit, cwd: path.join(root, 'not-a-repo') }), null);

    const withRemote = path.join(root, 'with-remote');
    mkdirSync(withRemote);
    spawnSync('git', ['init', '-q'], { cwd: withRemote });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: withRemote });
    assert.equal((await runNudge(root, { session_id: 'r3', transcript_path: commit, cwd: withRemote })).decision, 'block');

    // A local wiki is somewhere to record, remote or not.
    const localWiki = path.join(root, 'local-wiki');
    mkdirSync(path.join(localWiki, 'nimbalyst-local', 'wiki'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: localWiki });
    writeFileSync(path.join(localWiki, 'nimbalyst-local', 'wiki', '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
    assert.equal((await runNudge(root, { session_id: 'r4', transcript_path: commit, cwd: localWiki })).decision, 'block');
  });

  it('nudge never blocks when stop_hook_active or on bad input', async () => {
    const root = tempRoot();
    const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);
    assert.equal(await runNudge(root, { session_id: 'a', transcript_path: commit, stop_hook_active: true }), null);
    assert.equal(await runNudge(root, '{not json'), null);
    assert.equal(await runNudge(root, ''), null);
    assert.equal(await runNudge(root, { session_id: 'b', transcript_path: path.join(root, 'missing.jsonl') }), null);
    assert.equal(await runNudge(root, { transcript_path: commit }), null);
  });

  it('nudge keeps its markers in a private per-user state dir, not the shared temp dir', async () => {
    const root = tempRoot();
    const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);

    const xdg = path.join(root, 'xdg');
    assert.equal((await runNudge(root, { session_id: 'x1', transcript_path: commit }, { NIMBALYST_WIKI_NUDGE_STATE_DIR: '', XDG_STATE_HOME: xdg })).decision, 'block');
    const xdgDir = path.join(xdg, 'nimbalyst-wiki');
    assert.ok(existsSync(path.join(xdgDir, 'x1.nudged')));
    if (process.platform !== 'win32') assert.equal(statSync(xdgDir).mode & 0o777, 0o700);

    const home = path.join(root, 'home');
    assert.equal((await runNudge(root, { session_id: 'h1', transcript_path: commit }, { NIMBALYST_WIKI_NUDGE_STATE_DIR: '', XDG_STATE_HOME: '', HOME: home })).decision, 'block');
    assert.ok(existsSync(path.join(home, '.claude', 'state', 'nimbalyst-wiki', 'h1.nudged')));
  });

  function gitRepo(dir: string): string {
    mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // Sandboxed: git runs in the temp repository, never this checkout.
    assert.equal(realpathSync(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout.trim()), realpathSync(dir));
    return dir;
  }

  /** A project with a local wiki whose Sync page covers src/sync, and an uncommitted file there. */
  function wikiProject(dir: string): string {
    gitRepo(dir);
    const wiki = path.join(dir, 'nimbalyst-local', 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(path.join(wiki, '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
    writeFileSync(path.join(wiki, 'Home.md'), '---\nid: home\nsummary: The widget project.\n---\n\nWelcome.\n');
    writeFileSync(path.join(wiki, 'Sync protocol.md'), '---\nid: sync\npaths: [src/sync/**]\n---\n\n[Batch acks?]{open}\n');
    // No id: a writer's scan would add one.
    writeFileSync(path.join(wiki, 'Notes.md'), 'Loose notes.\n');
    mkdirSync(path.join(dir, 'src', 'sync'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'sync', 'a.ts'), 'a\n');
    return dir;
  }

  async function runContext(input: unknown, env: NodeJS.ProcessEnv = {}): Promise<string> {
    return (await runHook('session-start', JSON.stringify(input), { ...process.env, CLAUDE_PROJECT_DIR: '', ...env })) ?? '';
  }

  it('session-start context describes the local wiki, under the cap, and leaves files alone', async () => {
    const project = wikiProject(path.join(tempRoot(), 'project'));
    const out = await runContext({ hook_event_name: 'SessionStart', cwd: project });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = parsed.hookSpecificOutput.additionalContext;
    assert.match(context, /local wiki in nimbalyst-local\/wiki/);
    assert.match(context, /Home: The widget project\./);
    assert.match(context, /1 open question/);
    assert.match(context, /changed in the working tree: Sync protocol/);
    assert.ok(context.length <= 1500, `${context.length} chars`);
    // Read-only: the hook never repairs or writes the wiki.
    assert.equal(readFileSync(path.join(project, 'nimbalyst-local', 'wiki', 'Notes.md'), 'utf8'), 'Loose notes.\n');
    // CLAUDE_PROJECT_DIR wins over the hook's cwd.
    assert.match(await runContext({ cwd: path.join(project, 'src') }, { CLAUDE_PROJECT_DIR: project }), /widget project/);
  });

  it('session-start context prints nothing without a local wiki, or on bad input', async () => {
    const root = tempRoot();
    assert.equal(await runContext({ cwd: gitRepo(path.join(root, 'plain')) }), '');
    assert.equal(await runContext({ cwd: path.join(root, 'missing') }), '');
    const broken = path.join(root, 'broken');
    mkdirSync(path.join(broken, 'nimbalyst-local', 'wiki'), { recursive: true });
    writeFileSync(path.join(broken, 'nimbalyst-local', 'wiki', '.nimbalyst-wiki.yaml'), 'formatVersion: 99\n');
    assert.equal(await runContext({ cwd: broken }), '');
    assert.equal(await runHook('session-start', '{not json', { ...process.env, CLAUDE_PROJECT_DIR: '' }), null);
  });

  it('nudge names the local wiki pages covering the files the session edited', async () => {
    const root = tempRoot();
    const project = wikiProject(path.join(root, 'project'));
    const covered = transcript(root, 'covered', ['a.ts', 'b.ts', 'c.ts'].map((file) => toolUse('Edit', { file_path: path.join(project, 'src', 'sync', file) })));
    const reason = (await runNudge(root, { session_id: 'c1', transcript_path: covered, cwd: project })).reason;
    assert.match(reason, /3 file edits/);
    assert.match(reason, /covered by these wiki pages: Sync protocol\./);
    assert.match(reason, /\/nimbalyst-wiki:capture.*"nothing to record"/);

    // Edits outside every page's paths: the plain reminder.
    const elsewhere = transcript(root, 'elsewhere', ['a.ts', 'b.ts', 'c.ts'].map((file) => toolUse('Edit', { file_path: path.join(project, 'lib', file) })));
    assert.doesNotMatch((await runNudge(root, { session_id: 'c2', transcript_path: elsewhere, cwd: project })).reason, /covered by/);
  });
});
