// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/ExtensionLogService', () => ({ ExtensionLogService: { getInstance: vi.fn() } }));

import { detectExtensionPackageManager } from '../extensionBuild';

describe('detectExtensionPackageManager', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function project(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'ext-pm-'));
    roots.push(root);
    for (const [rel, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), contents);
    }
    return root;
  }

  it('follows the packageManager pin before any lockfile', () => {
    expect(detectExtensionPackageManager(project({ 'package.json': '{"packageManager":"pnpm@12.9.1"}', 'package-lock.json': '{}' }))).toBe('pnpm');
    expect(detectExtensionPackageManager(project({ 'package.json': '{"packageManager":"npm@11.0.0"}', 'pnpm-lock.yaml': '' }))).toBe('npm');
    expect(detectExtensionPackageManager(project({ 'package.json': '{"devEngines":{"packageManager":{"name":"pnpm"}}}' }))).toBe('pnpm');
  });

  it('inherits a pnpm workspace from an ancestor, but stops at a repository or npm lockfile boundary', () => {
    const monorepo = project({ 'pnpm-lock.yaml': '', 'packages/extensions/x/package.json': '{}' });
    expect(detectExtensionPackageManager(path.join(monorepo, 'packages/extensions/x'))).toBe('pnpm');

    const nested = project({ 'pnpm-lock.yaml': '', 'ext/.git/HEAD': '', 'ext/package.json': '{}' });
    expect(detectExtensionPackageManager(path.join(nested, 'ext'))).toBe('npm');

    const npmProject = project({ 'pnpm-workspace.yaml': '', 'ext/package-lock.json': '{}', 'ext/package.json': '{}' });
    expect(detectExtensionPackageManager(path.join(npmProject, 'ext'))).toBe('npm');
  });
});
