import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = path.join(repoRoot, 'scripts', 'staging', 'launch-nimbalyst-candidate.ps1');
const powershell = path.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const harmlessExecutable = path.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32',
  'where.exe',
);

function invoke(args) {
  return spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

test('candidate staging launcher validates a fully isolated contract without launching', () => {
  const candidateId = `launcher-test-${process.pid}`;
  const output = execFileSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launcher,
      '-CandidateExecutable',
      harmlessExecutable,
      '-CandidateId',
      candidateId,
      '-ValidateOnly',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  const receiptPath = output.trim().split(/\r?\n/).at(-1);
  assert.ok(receiptPath);
  assert.equal(existsSync(receiptPath), true);

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(receipt.status, 'validated');
  assert.equal(receipt.validateOnly, true);
  assert.equal(receipt.processId, null);
  assert.equal(receipt.startTimeUtc, null);
  assert.equal(receipt.environment.NIMBALYST_STAGING_MODE, '1');
  assert.equal(receipt.environment.NIMBALYST_USER_DATA_DIR, receipt.profilePath);
  assert.equal(receipt.environment.NIMBALYST_USER_DATA_PATH, receipt.profilePath);
  assert.equal(receipt.environment.NIMBALYST_CLAUDE_PROJECTS_DIR, receipt.claudeProjectsPath);
  assert.equal(receipt.environment.NIMBALYST_CDP_PORT, String(receipt.cdpPort));
  assert.equal(receipt.candidateMainLogPath, path.join(receipt.profilePath, 'logs', 'main.log'));
  assert.equal(receipt.receiptDirectory, path.dirname(receiptPath));
  assert.equal(receipt.processComparison.candidateProcessId, null);
  assert.equal(receipt.processComparison.candidateDistinctFromIncumbents, null);
  assert.ok(Array.isArray(receipt.processComparison.incumbentMatchingProcessIds));
  assert.equal(typeof receipt.processComparison.executableProcessName, 'string');
  assert.equal(receipt.isolation.pairwiseIsolated, true);
  assert.equal(existsSync(receipt.workspaceAnchorPath), true);
  assert.match(receipt.profilePath, /^D:\\Nimbalyst-Staging\\/i);
  assert.doesNotMatch(receipt.profilePath, /^D:\\!! CLAUDE(?:\\|$)/i);
});

test('candidate staging launcher rejects the normal default CDP port', () => {
  const result = invoke([
    '-CandidateExecutable',
    harmlessExecutable,
    '-CandidateId',
    `default-port-test-${process.pid}`,
    '-CdpPort',
    '9222',
    '-ValidateOnly',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /reserved as the normal Nimbalyst default/);
});

test('candidate staging launcher rejects candidate IDs that could escape isolation', () => {
  const result = invoke([
    '-CandidateExecutable',
    harmlessExecutable,
    '-CandidateId',
    '..\\live',
    '-ValidateOnly',
  ]);

  assert.notEqual(result.status, 0);
});

test('candidate staging launcher validates an unpackaged Electron app directory', () => {
  const fixtureRoot = `D:\\Nimbalyst-Staging\\launcher-app-fixture-${process.pid}`;
  const mainPath = path.join(fixtureRoot, 'out', 'main', 'index.js');
  mkdirSync(path.dirname(mainPath), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ name: 'candidate-app-fixture', main: 'out/main/index.js' })}\n`,
    'utf8',
  );
  writeFileSync(mainPath, '// candidate staging fixture\n', 'utf8');

  try {
    const output = execFileSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcher,
        '-CandidateExecutable',
        harmlessExecutable,
        '-CandidateAppPath',
        fixtureRoot,
        '-CandidateId',
        `app-path-test-${process.pid}`,
        '-ValidateOnly',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const receiptPath = output.trim().split(/\r?\n/).at(-1);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(receipt.candidateAppPath, fixtureRoot);
    assert.equal(receipt.candidateAppMainPath, mainPath);
    assert.equal(receipt.launchArguments[0], `"${fixtureRoot}"`);
    assert.equal(receipt.launchArguments[1], '--workspace');
    assert.match(receipt.launchArguments[3], /^--user-data-dir="/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('candidate staging launcher rejects a candidate app with a missing main file', () => {
  const fixtureRoot = `D:\\Nimbalyst-Staging\\launcher-missing-main-${process.pid}`;
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ name: 'candidate-app-fixture', main: 'missing.js' })}\n`,
    'utf8',
  );

  try {
    const result = invoke([
      '-CandidateExecutable',
      harmlessExecutable,
      '-CandidateAppPath',
      fixtureRoot,
      '-CandidateId',
      `missing-main-test-${process.pid}`,
      '-ValidateOnly',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /main file does not exist/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('candidate staging launcher rejects a relative candidate app path', () => {
  const result = invoke([
    '-CandidateExecutable',
    harmlessExecutable,
    '-CandidateAppPath',
    'packages\\electron',
    '-CandidateId',
    `relative-app-test-${process.pid}`,
    '-ValidateOnly',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be an absolute path/);
});

test('candidate staging launcher rejects an app path inside the live workspace', () => {
  const result = invoke([
    '-CandidateExecutable',
    harmlessExecutable,
    '-CandidateAppPath',
    'D:\\!! CLAUDE',
    '-CandidateId',
    `live-workspace-app-test-${process.pid}`,
    '-ValidateOnly',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be isolated from D:\\!! CLAUDE/);
});
