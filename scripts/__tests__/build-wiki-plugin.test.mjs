// @vitest-environment node
// Covers the build script that generates the desktop wiki skills and the
// nimbalyst-wiki plugin skills from one source, and the plugin's Stop-hook nudge.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyBranch, buildGeneratedFiles, checkGenerated, checkToolNames, writeGenerated } from '../build-wiki-plugin.mjs';

const NUDGE = fileURLToPath(new URL('../../plugins/nimbalyst-wiki/scripts/keeper-nudge.mjs', import.meta.url));
const REMOTE_SKILLS = fileURLToPath(new URL('../../plugins/nimbalyst-wiki/skills', import.meta.url));
const DESKTOP_SKILLS = fileURLToPath(new URL('../../packages/extensions/knowledge/claude-plugin/skills', import.meta.url));

function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureSource(root, body = 'Call `listPages`, then `tracker_create`.\n') {
  const source = path.join(root, 'source');
  for (const skill of ['update', 'setup']) {
    mkdirSync(path.join(source, skill, 'references'), { recursive: true });
    writeFileSync(path.join(source, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n\n# ${skill}\n\n${body}`);
    writeFileSync(path.join(source, skill, 'references', 'kind.yaml'), 'id: kind\n');
  }
  return source;
}

function fixtureTargets(root) {
  return { desktop: path.join(root, 'desktop'), remote: path.join(root, 'remote') };
}

test('a desktop-only tool outside a desktop-only block fails the build', (t) => {
  const root = tempRoot(t);
  const sourceDir = fixtureSource(root, 'Read the thread with `readCollabDocComments`.\n');
  assert.throws(() => buildGeneratedFiles(sourceDir), /(?:setup|update)\/SKILL\.md \(remote\): .*readCollabDocComments/);

  // The same name inside a desktop-only block reaches the desktop copy only.
  const fenced = fixtureSource(tempRoot(t), '<!-- desktop-only -->\nRead the thread with `readCollabDocComments`.\n<!-- /desktop-only -->\n');
  const files = buildGeneratedFiles(fenced);
  assert.match(files.get('desktop:update/SKILL.md'), /readCollabDocComments/);
  assert.doesNotMatch(files.get('remote:update/SKILL.md'), /readCollabDocComments/);
});

test('the remote check refuses desktop prefixes, retired wiki_* names and unknown tracker tools', () => {
  assert.deepEqual(checkToolNames('`listPages` `tracker_get` `pages_status` `list_session_inputs`', 'remote'), []);
  assert.deepEqual(
    checkToolNames('`mcp__nimbalyst-trackers__tracker_get`, `wiki_get`, `tracker_link_session`, `getResourceSharingStatus`', 'remote').sort(),
    ['getResourceSharingStatus', 'mcp__nimbalyst-trackers__tracker_get', 'tracker_link_session', 'wiki_get'],
  );
  // The desktop copy may not mention the terminal-only tools.
  assert.deepEqual(checkToolNames('`pages_status` and `list_session_inputs`', 'desktop').sort(), ['list_session_inputs', 'pages_status']);
  assert.deepEqual(checkToolNames('`readCollabDocComments` `tracker_link_session`', 'desktop'), []);
});

test('each side drops the other side\'s blocks and unwraps its own', () => {
  const source = [
    'Intro.',
    '',
    '<!-- desktop-only -->',
    'Decide `sharing`; drafts need publishing.',
    '<!-- /desktop-only -->',
    '<!-- remote-only -->',
    'The server owns sharing.',
    '<!-- /remote-only -->',
    '<!-- local-only -->',
    'Or a wiki of files.',
    '<!-- /local-only -->',
    '',
    'Outro.',
    '',
  ].join('\n');
  // Local blocks belong to the plugin copy only.
  assert.equal(applyBranch(source, 'remote', 'x.md'), 'Intro.\n\nThe server owns sharing.\nOr a wiki of files.\n\nOutro.\n');
  assert.equal(applyBranch(source, 'desktop', 'x.md'), 'Intro.\n\nDecide `sharing`; drafts need publishing.\n\nOutro.\n');
  assert.throws(() => applyBranch('<!-- desktop-only -->\nno end\n', 'remote', 'x.md'), /unbalanced/);
  assert.throws(() => applyBranch('<!-- remote-only -->\nno end\n', 'desktop', 'x.md'), /unbalanced/);
  // Files without markers pass through byte for byte, blank lines included.
  assert.equal(applyBranch('a\n\n\n\nb\n', 'remote'), 'a\n\n\n\nb\n');
});

test('generated files carry the generated marker, except references copied into pages', (t) => {
  const root = tempRoot(t);
  const sourceDir = fixtureSource(root, 'Follow `../setup/references/wiki-guide.md`, or run (`/wiki:setup`).\n');
  writeFileSync(path.join(sourceDir, 'setup', 'references', 'wiki-guide.md'), '# How we write this wiki\n');
  const targets = fixtureTargets(root);
  writeGenerated({ sourceDir, targets, bundle: false });
  // Each side's name, cross-references and command namespace.
  for (const [dir, update, setup, command] of [
    [targets.desktop, 'update', 'setup', '/wiki:setup'],
    [targets.remote, 'update', 'setup', '/nimbalyst-wiki:setup'],
  ]) {
    const skill = readFileSync(path.join(dir, update, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(`(\`${command}\`)`), command);
    assert.match(skill, new RegExp(`^---\\nname: ${update}\\n`));
    assert.match(skill, new RegExp(`Follow \`\\.\\./${setup}/references/wiki-guide\\.md\``));
    assert.match(skill, /<!-- GENERATED by scripts\/build-wiki-plugin\.mjs/);
    assert.match(readFileSync(path.join(dir, update, 'references', 'kind.yaml'), 'utf8'), /^# GENERATED .*\nid: kind\n$/);
    // The guide is installed verbatim as the team's guide page.
    assert.equal(readFileSync(path.join(dir, setup, 'references', 'wiki-guide.md'), 'utf8'), '# How we write this wiki\n');
  }
});

test('check mode reports drift in either target and either direction', (t) => {
  const root = tempRoot(t);
  const sourceDir = fixtureSource(root);
  const targets = fixtureTargets(root);
  writeGenerated({ sourceDir, targets, bundle: false });
  assert.deepEqual(checkGenerated({ sourceDir, targets, bundle: false }), []);

  appendFileSync(path.join(sourceDir, 'setup', 'SKILL.md'), 'Then call `tracker_get`.\n');
  writeFileSync(path.join(targets.remote, 'update', 'references', 'stray.yaml'), 'id: stray\n');
  assert.deepEqual(checkGenerated({ sourceDir, targets, bundle: false }).sort(), [
    'changed: desktop:setup/SKILL.md',
    'changed: remote:setup/SKILL.md',
    'extra: remote:update/references/stray.yaml',
  ]);

  writeGenerated({ sourceDir, targets, bundle: false });
  assert.deepEqual(checkGenerated({ sourceDir, targets, bundle: false }), []);
});

test('the skill references the web console reads stay where it reads them', () => {
  // nimbalyst-collab web-console/scripts/knowledge-wiki-codec.mjs reads these two paths.
  const source = fileURLToPath(new URL('../../packages/extensions/knowledge/skills-source', import.meta.url));
  for (const rel of ['setup/references/wiki-guide.md', 'update/references/relations.yaml']) assert.ok(existsSync(path.join(source, rel)), rel);
});

test('committed desktop skills, plugin skills and session helper match the source', async () => {
  assert.deepEqual(await checkGenerated(), []);
});

test('committed plugin skills cover the team project and the local wiki; desktop skills never name terminal tools', () => {
  for (const skill of ['update', 'setup']) {
    const remote = readFileSync(path.join(REMOTE_SKILLS, skill, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(remote, /section: personal|\/app\/|wiki_|(?:desktop|remote|local)-only/);
    assert.match(remote, /pages_status/);
    assert.match(remote, /## On a local wiki/);
    const desktop = readFileSync(path.join(DESKTOP_SKILLS, skill, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(desktop, /pages_status|list_session_inputs|initLocalWiki|nimbalyst-local|(?:desktop|remote|local)-only/);
  }
});

function toolUse(name, input) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
}

function runNudge(root, input, env = {}) {
  const result = spawnSync(process.execPath, [NUDGE], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, NIMBALYST_WIKI_NUDGE_STATE_DIR: path.join(root, 'state'), NIMBALYST_WIKI_NUDGE_MIN_EDITS: '3', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function transcript(root, name, lines) {
  const file = path.join(root, `${name}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('nudge blocks once per session, and only after substantive work', (t) => {
  const root = tempRoot(t);
  const edits = transcript(root, 'edits', [
    toolUse('Read', { file_path: 'a.ts' }),
    ...['a.ts', 'b.ts', 'c.ts'].map((file) => toolUse('Edit', { file_path: file })),
  ]);
  const first = runNudge(root, { session_id: 's1', transcript_path: edits, stop_hook_active: false });
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /3 file edits.*\/nimbalyst-wiki:capture.*"nothing to record"/);
  assert.equal(runNudge(root, { session_id: 's1', transcript_path: edits }), null);

  // The threshold is overridable, and below it nothing happens.
  assert.equal(runNudge(root, { session_id: 's2', transcript_path: edits }, { NIMBALYST_WIKI_NUDGE_MIN_EDITS: '4' }), null);

  const commit = transcript(root, 'commit', ['not json', toolUse('Bash', { command: 'git add x && git commit -m "x"' })]);
  assert.match(runNudge(root, { session_id: 's3', transcript_path: commit }).reason, /1 git commit/);
  const plan = transcript(root, 'plan', [toolUse('Write', { file_path: '/repo/nimbalyst-local/plans/thing.md' })]);
  assert.match(runNudge(root, { session_id: 's4', transcript_path: plan }).reason, /a plan/);

  // Already recorded through the plugin's Pages tools, or the desktop's: no nudge.
  const writes = [
    'mcp__plugin_nimbalyst-wiki_nimbalyst-team__applyCollabDocEdit',
    'mcp__plugin_nimbalyst-wiki_nimbalyst-team__createSharedDoc',
    'mcp__plugin_nimbalyst-wiki_nimbalyst-team__setPageType',
    'mcp__plugin_nimbalyst-wiki_nimbalyst-team__moveSharedItem',
    'mcp__plugin_nimbalyst-wiki_nimbalyst-team__tracker_create',
    'mcp__nimbalyst-trackers__tracker_update',
  ];
  writes.forEach((name, i) => {
    const captured = transcript(root, `captured-${i}`, [toolUse('Bash', { command: 'git commit -m x' }), toolUse(name, { id: 'X' })]);
    assert.equal(runNudge(root, { session_id: `s5-${i}`, transcript_path: captured }), null, name);
  });
  // Reads, and the retired wiki_* names, are not a record.
  for (const name of ['mcp__plugin_nimbalyst-wiki_nimbalyst-team__readCollabDoc', 'mcp__plugin_nimbalyst-wiki_nimbalyst-wiki__wiki_update_item']) {
    const read = transcript(root, `read-${name.length}`, [toolUse('Bash', { command: 'git commit -m x' }), toolUse(name, { id: 'X' })]);
    assert.equal(runNudge(root, { session_id: `s6-${name.length}`, transcript_path: read }).decision, 'block', name);
  }
});

test('nudge stays quiet with no wiki to record into: no git remote and no local wiki', (t) => {
  const root = tempRoot(t);
  const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);
  const noRemote = path.join(root, 'no-remote');
  mkdirSync(noRemote);
  spawnSync('git', ['init', '-q'], { cwd: noRemote });
  assert.equal(runNudge(root, { session_id: 'r1', transcript_path: commit, cwd: noRemote }), null);
  assert.equal(runNudge(root, { session_id: 'r2', transcript_path: commit, cwd: path.join(root, 'not-a-repo') }), null);

  const withRemote = path.join(root, 'with-remote');
  mkdirSync(withRemote);
  spawnSync('git', ['init', '-q'], { cwd: withRemote });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: withRemote });
  assert.equal(runNudge(root, { session_id: 'r3', transcript_path: commit, cwd: withRemote }).decision, 'block');

  // A local wiki is somewhere to record, remote or not.
  const localWiki = path.join(root, 'local-wiki');
  mkdirSync(path.join(localWiki, 'nimbalyst-local', 'wiki'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: localWiki });
  writeFileSync(path.join(localWiki, 'nimbalyst-local', 'wiki', '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
  assert.equal(runNudge(root, { session_id: 'r4', transcript_path: commit, cwd: localWiki }).decision, 'block');
});

test('nudge never blocks when stop_hook_active or on bad input', (t) => {
  const root = tempRoot(t);
  const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);
  assert.equal(runNudge(root, { session_id: 'a', transcript_path: commit, stop_hook_active: true }), null);
  assert.equal(runNudge(root, '{not json'), null);
  assert.equal(runNudge(root, ''), null);
  assert.equal(runNudge(root, { session_id: 'b', transcript_path: path.join(root, 'missing.jsonl') }), null);
  assert.equal(runNudge(root, { transcript_path: commit }), null);
});

test('nudge keeps its markers in a private per-user state dir, not the shared temp dir', (t) => {
  const root = tempRoot(t);
  const commit = transcript(root, 'commit', [toolUse('Bash', { command: 'git commit -m x' })]);

  const xdg = path.join(root, 'xdg');
  assert.equal(runNudge(root, { session_id: 'x1', transcript_path: commit }, { NIMBALYST_WIKI_NUDGE_STATE_DIR: '', XDG_STATE_HOME: xdg }).decision, 'block');
  const xdgDir = path.join(xdg, 'nimbalyst-wiki');
  assert.ok(existsSync(path.join(xdgDir, 'x1.nudged')));
  if (process.platform !== 'win32') assert.equal(statSync(xdgDir).mode & 0o777, 0o700);

  const home = path.join(root, 'home');
  assert.equal(runNudge(root, { session_id: 'h1', transcript_path: commit }, { NIMBALYST_WIKI_NUDGE_STATE_DIR: '', XDG_STATE_HOME: '', HOME: home }).decision, 'block');
  assert.ok(existsSync(path.join(home, '.claude', 'state', 'nimbalyst-wiki', 'h1.nudged')));
});
