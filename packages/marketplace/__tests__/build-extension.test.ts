// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempRoots: string[] = [];
const buildScript = path.resolve(__dirname, '../scripts/build-extension.sh');

function makeFixture(agentWorkflowsPath: string): {
  extensionDir: string;
  outputDir: string;
  root: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'nimbalyst-marketplace-build-'));
  tempRoots.push(root);
  const extensionDir = path.join(root, 'extension');
  const outputDir = path.join(root, 'output');
  mkdirSync(path.join(extensionDir, 'dist'), { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(extensionDir, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'com.nimbalyst.fixture',
    name: 'Fixture',
    version: '1.0.0',
    contributions: {
      agentWorkflows: { path: agentWorkflowsPath },
    },
  }));
  return { extensionDir, outputDir, root };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-extension.sh agent workflows', () => {
  it('packages the declared agent workflows at their manifest-relative path', () => {
    const fixture = makeFixture('agent-workflows');
    const skillDir = path.join(fixture.extensionDir, 'agent-workflows', 'skills', 'fixture');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Fixture workflow\n');

    execFileSync(buildScript, [
      fixture.extensionDir,
      '--output-dir',
      fixture.outputDir,
    ], {
      env: { ...process.env, NIMBALYST_SKIP_BUILD: '1' },
      stdio: 'pipe',
    });

    const archive = path.join(fixture.outputDir, 'com.nimbalyst.fixture-1.0.0.nimext');
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    expect(entries).toContain('agent-workflows/skills/fixture/SKILL.md');
  });

  it('rejects a declared workflow path that escapes the extension', () => {
    const fixture = makeFixture('../outside-workflows');
    mkdirSync(path.join(fixture.root, 'outside-workflows'), { recursive: true });

    const result = spawnSync(buildScript, [
      fixture.extensionDir,
      '--output-dir',
      fixture.outputDir,
    ], {
      env: { ...process.env, NIMBALYST_SKIP_BUILD: '1' },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must stay inside the extension');
  });
});
