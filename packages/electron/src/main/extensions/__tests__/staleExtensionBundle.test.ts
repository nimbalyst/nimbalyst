import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  detectStaleBuiltinExtensionBundle,
  formatStaleBundleWarning,
} from '../staleExtensionBundle';

let root: string;

async function write(rel: string, contents: string, mtimeMs?: number): Promise<string> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  if (mtimeMs !== undefined) {
    const when = new Date(mtimeMs);
    await fs.utimes(full, when, when);
  }
  return full;
}

describe('detectStaleBuiltinExtensionBundle', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'stale-bundle-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports stale when a source file is newer than the built entry', async () => {
    await write('dist/index.js', 'built', 1_000);
    await write('src/index.tsx', 'source', 5_000);

    const report = await detectStaleBuiltinExtensionBundle('ext.a', root, 'dist/index.js');
    expect(report).not.toBeNull();
    expect(report?.newestSrcRel).toBe(path.join('src', 'index.tsx'));
    expect(formatStaleBundleWarning(report!)).toContain('stale dev bundle');
  });

  it('returns null when the built entry is newer than all source', async () => {
    await write('src/index.tsx', 'source', 1_000);
    await write('dist/index.js', 'built', 9_000);

    const report = await detectStaleBuiltinExtensionBundle('ext.a', root, 'dist/index.js');
    expect(report).toBeNull();
  });

  it('reports stale when the built entry is missing entirely', async () => {
    await write('src/index.tsx', 'source', 1_000);

    const report = await detectStaleBuiltinExtensionBundle('ext.a', root, 'dist/index.js');
    expect(report?.builtMs).toBe(0);
    expect(formatStaleBundleWarning(report!)).toContain('built entry is missing');
  });

  it('returns null when there is no src directory (prebuilt extension)', async () => {
    await write('dist/index.js', 'built', 1_000);

    const report = await detectStaleBuiltinExtensionBundle('ext.a', root, 'dist/index.js');
    expect(report).toBeNull();
  });

  it('ignores files under dist/node_modules when scanning source', async () => {
    await write('src/index.tsx', 'source', 1_000);
    await write('dist/index.js', 'built', 5_000);
    // A newer file that must NOT be counted as source.
    await write('node_modules/pkg/index.js', 'dep', 9_000);

    const report = await detectStaleBuiltinExtensionBundle('ext.a', root, 'dist/index.js');
    expect(report).toBeNull();
  });
});
