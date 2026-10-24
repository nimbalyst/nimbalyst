// @vitest-environment node
// Covers the build script that generates the desktop wiki skills and the
// nimbalyst-wiki plugin skills from one source, the plugin's generated configs,
// and staging the nimbalyst-wiki repository. The hooks are tested with the CLI
// that runs them (packages/cli/src/mcp/__tests__/wikiContext.test.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyBranch, buildGeneratedFiles, buildPluginConfigs, checkGenerated, checkManifestVersions, checkToolNames, cliSpec, PLUGIN_DIR, TEAM_PLUGIN_DIR, writeGenerated } from '../build-wiki-plugin.mjs';
import { shimSpawnConfig } from '../package-manager.mjs';
import { canRunPinnedCli, directoryLimitFindings, unbumpedChanges } from '../stage-wiki-repo.mjs';

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
  // pagesForFiles is the local server's: the plugin copy may name it, the desktop copy may not.
  assert.deepEqual(checkToolNames('`pagesForFiles`', 'remote'), []);
  assert.deepEqual(checkToolNames('`pagesForFiles`', 'desktop'), ['pagesForFiles']);
  assert.deepEqual(checkToolNames('`wikiDoctor` `listMarks`', 'remote'), []);
  assert.deepEqual(checkToolNames('`wikiDoctor` `listMarks`', 'desktop').sort(), ['listMarks', 'wikiDoctor']);
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
  writeGenerated({ sourceDir, targets, configs: false });
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
  writeGenerated({ sourceDir, targets, configs: false });
  assert.deepEqual(checkGenerated({ sourceDir, targets, configs: false }), []);

  appendFileSync(path.join(sourceDir, 'setup', 'SKILL.md'), 'Then call `tracker_get`.\n');
  writeFileSync(path.join(targets.remote, 'update', 'references', 'stray.yaml'), 'id: stray\n');
  assert.deepEqual(checkGenerated({ sourceDir, targets, configs: false }).sort(), [
    'changed: desktop:setup/SKILL.md',
    'changed: remote:setup/SKILL.md',
    'extra: remote:update/references/stray.yaml',
  ]);

  writeGenerated({ sourceDir, targets, configs: false });
  assert.deepEqual(checkGenerated({ sourceDir, targets, configs: false }), []);
});

test('CRLF skill sources generate the same content as LF sources', (t) => {
  const sourceDir = fixtureSource(tempRoot(t), '<!-- desktop-only -->\nRead `readCollabDocComments`.\n<!-- /desktop-only -->\n<!-- remote-only -->\nCall `pages_status`.\n<!-- /remote-only -->\n<!-- local-only -->\nCall `wikiDoctor`.\n<!-- /local-only -->\n');
  const expected = buildGeneratedFiles(sourceDir);
  for (const skill of ['setup', 'update']) {
    for (const rel of ['SKILL.md', 'references/kind.yaml']) {
      const file = path.join(sourceDir, skill, rel);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    }
  }
  assert.deepEqual(buildGeneratedFiles(sourceDir), expected);
});

test('CRLF generated skills pass check mode but content drift still fails', (t) => {
  const root = tempRoot(t);
  const sourceDir = fixtureSource(root);
  const targets = fixtureTargets(root);
  writeGenerated({ sourceDir, targets, configs: false });
  for (const dir of Object.values(targets)) {
    for (const skill of ['setup', 'update']) {
      for (const rel of ['SKILL.md', 'references/kind.yaml']) {
        const file = path.join(dir, skill, rel);
        writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
      }
    }
  }
  assert.deepEqual(checkGenerated({ sourceDir, targets, configs: false }), []);
  appendFileSync(path.join(targets.remote, 'setup', 'SKILL.md'), 'Unexpected text.\r\n');
  assert.deepEqual(checkGenerated({ sourceDir, targets, configs: false }), ['changed: remote:setup/SKILL.md']);
});

test('CRLF generated plugin configs pass check mode but content drift still fails', (t) => {
  const root = tempRoot(t);
  const sourceDir = fixtureSource(root);
  const targets = fixtureTargets(root);
  const pluginDir = path.join(root, 'plugin');
  fixturePlugin(pluginDir, '1.2.3');
  writeGenerated({ sourceDir, targets, configs: false });
  for (const [rel, content] of buildPluginConfigs(pluginDir)) {
    const file = path.join(pluginDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content.replace(/\n/g, '\r\n'));
  }
  assert.deepEqual(checkGenerated({ sourceDir, targets, pluginDir }), []);
  for (const [rel, content] of buildPluginConfigs(pluginDir)) {
    const file = path.join(pluginDir, rel);
    writeFileSync(file, content.replace('1.2.3', '9.9.9').replace(/\n/g, '\r\n'));
    const label = path.relative(path.resolve(PLUGIN_DIR, '../..'), file);
    assert.deepEqual(checkGenerated({ sourceDir, targets, pluginDir }), [`changed: ${label}`]);
    writeFileSync(file, content.replace(/\n/g, '\r\n'));
  }
});

test('the skill references the web console reads stay where it reads them', () => {
  // nimbalyst-collab web-console/scripts/knowledge-wiki-codec.mjs reads these two paths.
  const source = fileURLToPath(new URL('../../packages/extensions/knowledge/skills-source', import.meta.url));
  for (const rel of ['setup/references/wiki-guide.md', 'update/references/relations.yaml']) assert.ok(existsSync(path.join(source, rel)), rel);
});

test('the setup skill compares a team\'s guide against the version the base guide carries', () => {
  // Setup reports "edited by the team" or "base changed" from this number, so a
  // guide bumped without the skill (or the reverse) misreports every wiki.
  const source = fileURLToPath(new URL('../../packages/extensions/knowledge/skills-source/setup', import.meta.url));
  const guide = readFileSync(path.join(source, 'references', 'wiki-guide.md'), 'utf8');
  const skill = readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  const guideVersion = guide.trim().match(/base guide, version (\d+)\.$/)?.[1];
  assert.ok(guideVersion, 'the guide ends with its version line');
  assert.ok(skill.includes(`**Base version:** ${guideVersion}.`), `setup/SKILL.md names base version ${guideVersion}`);
  for (const mentioned of skill.matchAll(/(?:base version|version line) (\d+)/g)) assert.equal(mentioned[1], guideVersion, mentioned[0]);
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

test('the plugin runs its servers and hooks from @nimbalyst/cli pinned to its own version, and ships no scripts', () => {
  const spec = cliSpec();
  assert.equal(spec, `@nimbalyst/cli@${JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).version}`);
  const mcp = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(mcp['nimbalyst-local'].args, ['--prefix', '/', '-y', spec, 'mcp', '--plugin-root', '${CLAUDE_PLUGIN_ROOT}']);
  assert.deepEqual(mcp['nimbalyst-session'].args, ['--prefix', '/', '-y', spec, 'hook', 'session-inputs']);
  // Codex expands no variables, and npx replaces PWD, so Codex starts the server in the project and names itself.
  // Codex passes servers a filtered environment; a custom CODEX_HOME must be forwarded for the server to find its install.
  const codex = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.codex-mcp.json'), 'utf8')).mcpServers['nimbalyst-local'];
  assert.deepEqual(codex, { command: 'npx', env_vars: ['CODEX_HOME'], args: ['--prefix', '/', '-y', spec, 'mcp', '--plugin-agent', 'codex'] });
  const hooks = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionStart[0].hooks[0].command, `npx --prefix / -y ${spec} hook session-start`);
  assert.equal(hooks.Stop[0].hooks[0].command, `npx --prefix / -y ${spec} hook stop`);
  assert.ok(!existsSync(path.join(PLUGIN_DIR, 'scripts')), 'the plugin ships no scripts');
});

test('npx runs the published CLI even in a project that has its own @nimbalyst/cli at the pinned version', () => {
  // This monorepo links packages/cli into node_modules at the plugin's version, so a bare npx ran its stale local build.
  const project = mkdtempSync(path.join(tmpdir(), 'wiki-npx-'));
  try {
    const version = '0.0.0-local-only';
    const pkg = path.join(project, 'node_modules', '@nimbalyst', 'cli');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@nimbalyst/cli', version, bin: { nim: 'bin/nim.js' } }));
    writeFileSync(path.join(pkg, 'bin', 'nim.js'), '#!/usr/bin/env node\nconsole.log("LOCAL COPY");\n', { mode: 0o755 });
    mkdirSync(path.join(project, 'node_modules', '.bin'));
    symlinkSync('../@nimbalyst/cli/bin/nim.js', path.join(project, 'node_modules', '.bin', 'nim'));
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'host', private: true }));
    const configs = buildPluginConfigs();
    const args = JSON.parse(configs.get('.mcp.json')).mcpServers['nimbalyst-session'].args
      .map((arg) => (arg === cliSpec() ? `@nimbalyst/cli@${version}` : arg));
    // --offline: the fake version is in no registry, so npx fails unless it picks the project's copy.
    const launch = shimSpawnConfig('npx');
    const run = spawnSync(launch.command, [...launch.argsPrefix, '--offline', ...args], {
      cwd: project,
      encoding: 'utf8',
      input: '',
    });
    assert.equal(run.error, undefined, run.error?.message);
    assert.doesNotMatch(run.stderr, /not recognized|command not found|ENOENT/i);
    assert.doesNotMatch(run.stdout, /LOCAL COPY/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

function fixturePlugin(dir, version, script = 'v1') {
  for (const manifest of ['.claude-plugin', '.codex-plugin']) {
    mkdirSync(path.join(dir, manifest), { recursive: true });
    writeFileSync(path.join(dir, manifest, 'plugin.json'), JSON.stringify({ version }));
  }
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'server.mjs'), script);
  writeFileSync(path.join(dir, 'README.md'), `readme ${script}`);
}

test('the Claude Code and Codex manifests must carry the same version', (t) => {
  const root = tempRoot(t);
  const team = path.join(root, 'team');
  fixturePlugin(root, '0.5.0');
  fixturePlugin(team, '0.5.0');
  assert.deepEqual(checkManifestVersions(root, team), []);
  writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.4.0' }));
  assert.deepEqual(checkManifestVersions(root, team), ['version mismatch: .claude-plugin/plugin.json is 0.5.0, .codex-plugin/plugin.json is 0.4.0']);
  writeFileSync(path.join(team, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.4.0' }));
  assert.match(checkManifestVersions(root, team)[1], /^nimbalyst-wiki-team: version mismatch/);
});

test('the team add-on is released under the plugin\'s version', (t) => {
  // The update check reads only nimbalyst-wiki's manifest, so an add-on on its
  // own version would never be offered to anyone who already has it.
  const root = tempRoot(t);
  const plugin = path.join(root, 'plugin');
  const team = path.join(root, 'team');
  fixturePlugin(plugin, '0.8.0');
  fixturePlugin(team, '0.8.0');
  assert.deepEqual(checkManifestVersions(plugin, team), []);
  fixturePlugin(team, '0.7.0');
  assert.deepEqual(checkManifestVersions(plugin, team), ['version mismatch: nimbalyst-wiki-team is 0.7.0, nimbalyst-wiki is 0.8.0']);
});

test('only the team add-on declares the team server, so local-only users are never asked to sign in', () => {
  const servers = (dir, file) => Object.keys(JSON.parse(readFileSync(path.join(dir, file), 'utf8')).mcpServers);
  for (const file of ['.mcp.json', '.codex-mcp.json']) {
    assert.deepEqual(servers(PLUGIN_DIR, file).sort(), ['nimbalyst-local', 'nimbalyst-session'], file);
    assert.deepEqual(servers(TEAM_PLUGIN_DIR, file), ['nimbalyst-team'], file);
  }
});

test('staging refuses a changed plugin under the version already staged', (t) => {
  const root = tempRoot(t);
  const plugin = path.join(root, 'plugin');
  const staged = path.join(root, 'staged');
  fixturePlugin(staged, '0.5.0', 'v1');

  fixturePlugin(plugin, '0.5.0', 'v1');
  assert.deepEqual(unbumpedChanges(plugin, staged), [], 'unchanged plugin restages');
  writeFileSync(path.join(plugin, 'README.md'), 'only the readme changed');
  assert.deepEqual(unbumpedChanges(plugin, staged), [], 'a README change needs no bump');

  fixturePlugin(plugin, '0.5.0', 'v2');
  assert.deepEqual(unbumpedChanges(plugin, staged), ['scripts/server.mjs']);
  fixturePlugin(plugin, '0.6.0', 'v2');
  assert.deepEqual(unbumpedChanges(plugin, staged), [], 'a bumped version may change anything');
  assert.deepEqual(unbumpedChanges(plugin, path.join(root, 'empty')), [], 'a first staging has nothing to compare');
});

test('staging refuses what the plugin directory cannot validate and lists what holds a version for review', (t) => {
  const root = tempRoot(t);
  const write = (rel, bytes) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), Buffer.alloc(bytes, 0x61));
  };
  write('.git/objects/pack/big.pack', 6 * 1024 * 1024);
  write('README.md', 100);
  write('scripts/server.mjs', 300 * 1024);
  write('docs/images/shot.webp', 300 * 1024);
  assert.deepEqual(directoryLimitFindings(root), { blocking: [], held: ['scripts/server.mjs is 300 KiB; non-image files over 256 KiB are held for a reviewer'] }, '.git is not part of the plugin; images may exceed 256 KiB');

  write('web/assets/ts.worker.js', 5 * 1024 * 1024);
  write('skills/.DS_Store', 10);
  const { blocking } = directoryLimitFindings(root);
  assert.deepEqual(blocking.sort(), ['skills/.DS_Store is a system file the directory refuses', 'web/assets/ts.worker.js is 5.0 MiB; every file must be under 5 MiB']);
});

test('staging refuses a plugin until npx can install and run its pinned CLI', () => {
  const calls = [];
  const runs = (out) => (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return out;
  };
  assert.equal(canRunPinnedCli('@nimbalyst/cli@1.2.3', runs('1.2.3\n')), true);
  // What a user's plugin runs, with fresh registry metadata, from outside this repository (whose devEngines npm refuses).
  assert.deepEqual(calls[0].args, ['-y', '--prefer-online', '@nimbalyst/cli@1.2.3', '--version']);
  assert.equal(calls[0].command, 'npx');
  assert.ok(!calls[0].cwd.startsWith(path.resolve(PLUGIN_DIR, '../..')), calls[0].cwd);
  assert.equal(canRunPinnedCli('@nimbalyst/cli@1.2.3', runs('1.2.2\n')), false, 'a different version answered');
  // Right after a publish the CLI resolves before its pinned wiki-web does: npx fails with ETARGET.
  assert.equal(canRunPinnedCli('@nimbalyst/cli@1.2.3', () => { throw new Error('ETARGET'); }), false);
});
