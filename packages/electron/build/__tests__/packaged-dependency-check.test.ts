// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { findUnresolvedDependencies } = require_('../packaged-dependency-check.js');

function check(packages: Record<string, { name: string; dependencies?: Record<string, string> }>) {
  const files = Object.keys(packages).flatMap((dir) => [`${dir}/package.json`, `${dir}/index.js`]);
  return findUnresolvedDependencies(files, (file: string) => packages[file.replace(/\/package\.json$/, '')] ?? null);
}

describe('packaged dependency check', () => {
  it('flags a hoisted module whose dependency was not packaged', () => {
    // The pnpm-collector shape: p-locate@3 got the root p-limit@3, whose yocto-queue was dropped.
    expect(check({
      '/node_modules/p-locate': { name: 'p-locate', dependencies: { 'p-limit': '^2.0.0' } },
      '/node_modules/p-limit': { name: 'p-limit', dependencies: { 'yocto-queue': '^0.1.0' } },
    })).toEqual([
      'node_modules/p-limit requires yocto-queue@^0.1.0, which is not packaged where Node can find it',
    ]);
  });

  it('resolves nested and ancestor node_modules the way Node does, and skips allowlisted deps', () => {
    expect(check({
      '/node_modules/conf': { name: 'conf', dependencies: { semver: '^7', 'json-schema-typed': '^7' } },
      '/node_modules/conf/node_modules/json-schema-typed': { name: 'json-schema-typed', dependencies: { semver: '^7' } },
      '/node_modules/semver': { name: 'semver' },
      '/node_modules/@vscode/ripgrep': { name: '@vscode/ripgrep', dependencies: { yauzl: '^2.9.2' } },
    })).toEqual([]);
  });
});
