// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { ElectronFileSystemService } from '../ElectronFileSystemService';
import { buildExtensionFindFilesPlan } from '../../ipc/extensionFindFilesPlan';

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';

vi.mock('../../utils/logger', () => ({ logger: { ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../ripgrepPath', () => ({ getRipgrepPath: () => '/unused-in-file-list-test' }));

// Every installed copy of an unscoped package, found by walking the installed
// trees so the list follows the package manager's layout instead of hardcoding it.
function installedCopies(name: string): string[] {
  const found = new Map<string, string>();
  const visit = (nodeModules: string, depth: number) => {
    if (depth > 8 || !existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const dirs = entry.name.startsWith('@')
        ? readdirSync(join(nodeModules, entry.name)).map(child => join(nodeModules, entry.name, child))
        : [join(nodeModules, entry.name)];
      for (const dir of dirs) {
        if (entry.name === name && existsSync(join(dir, 'package.json'))) {
          found.set(realpathSync(dir), relative(process.cwd(), dir));
        }
        if (!entry.isSymbolicLink()) visit(join(dir, 'node_modules'), depth + 1);
      }
    }
  };
  const owners = ['.', ...['packages', 'packages/extensions'].flatMap(parent =>
    readdirSync(resolve(parent)).map(child => join(parent, child)))];
  for (const owner of owners) visit(resolve(owner, 'node_modules'), 0);
  return [...found.values()].sort();
}

// Exercise the real installed leaf behind every distinct minimatch copy.
// Hostile patterns run only in disposable, heap/time/output-bounded Node children.
const callers = installedCopies('minimatch');

it('finds the installed minimatch copies', () => {
  expect(callers.length).toBeGreaterThan(1);
});
const fixtures = [
  ['comma groups', "'{' + '{a},'.repeat(8000) + 'b}'"],
  ['array append', "'{{x},' + 'a,'.repeat(130000) + 'b}'"],
  ['nested groups', "'{'.repeat(4000) + 'a,b' + '}'.repeat(4000)"],
] as const;

function run(entry: string, patternExpression: string, minimatch = false) {
  return spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=commonjs', '-e', `
    const api = require(${JSON.stringify(entry)});
    const expand = ${minimatch ? 'api.braceExpand' : "typeof api === 'function' ? api : api.expand"};
    const result = expand(${patternExpression});
    if (!Array.isArray(result) || !result.length) throw new Error('Missing expansion');
    process.stdout.write(JSON.stringify({count: result.length}));
  `], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8' });
}

describe('installed brace-expansion security and glob contracts', () => {
  for (const caller of callers) {
    const req = createRequire(resolve(caller, 'package.json'));
    const leaf = req.resolve('brace-expansion');
    const minimatch = req.resolve(resolve(caller));
    for (const [name, pattern] of fixtures) {
      it(`${caller} handles ${name} without stack exhaustion`, () => {
        const child = run(leaf, pattern);
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
      });
    }
    it(`${caller} retains ordinary, escaped, numeric and nested expansion`, () => {
      const api = req('brace-expansion');
      const expand = typeof api === 'function' ? api : api.expand;
      expect(expand('src/{a,{b,c}}.{ts,js}')).toEqual(['src/a.ts', 'src/a.js', 'src/b.ts', 'src/b.js', 'src/c.ts', 'src/c.js']);
      expect(expand('file{03..01}.txt')).toEqual(['file03.txt', 'file02.txt', 'file01.txt']);
      expect(expand(String.raw`x\{a,b\}`)).toEqual(['x{a,b}']);
      expect(expand('x{{a,b}}y')).toEqual(['x{a}y', 'x{b}y']);
      expect(expand('{a},b}')).toEqual(['a}', 'b']);
    });
    it(`${caller} safely expands hostile patterns through the real minimatch API`, () => {
      const child = run(minimatch, fixtures[0][1], true);
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(0);
    });
  }
});

it('production file listing and extension matching retain nested brace patterns with real glob/minimatch', async () => {
  await mkdir(resolve('.vitest'), { recursive: true });
  const workspace = await mkdtemp(resolve('.vitest/brace-glob-'));
  const service = new ElectronFileSystemService(workspace);
  try {
    await mkdir(resolve(workspace, 'src/node_modules'), { recursive: true });
    for (const name of ['a.ts', 'b.js', 'c.ts', 'skip.md', 'node_modules/ignored.ts']) {
      await writeFile(resolve(workspace, 'src', name), 'fixture');
    }
    const pattern = 'src/{a,{b,c}}.{ts,js}';
    const listed = await service.listFiles({ pattern, recursive: true, maxDepth: 32 });
    expect(listed.success).toBe(true);
    expect(listed.files?.map(file => file.path.split(sep).join('/')).sort()).toEqual(['src/a.ts', 'src/b.js', 'src/c.ts']);
    const plan = buildExtensionFindFilesPlan(workspace, pattern);
    expect(plan.scanRoot).toBe(resolve(workspace, 'src'));
    expect(['src/a.ts', 'src/b.js', 'src/c.ts', 'src/skip.md'].filter(file => minimatch(file, plan.normalizedPattern))).toEqual(['src/a.ts', 'src/b.js', 'src/c.ts']);
    const excluded = await service.listFiles({ pattern: '**/*.{ts,js}', recursive: true, maxDepth: 32 });
    expect(excluded.files?.map(file => file.path.split(sep).join('/')).sort()).toEqual(['src/a.ts', 'src/b.js', 'src/c.ts']);
  } finally {
    service.destroy();
    await rm(workspace, { recursive: true, force: true });
  }
});
