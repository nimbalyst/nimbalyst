// @vitest-environment node
/**
 * Guards the renderer's `optimizeDeps` policy for RevoGrid (NIM-2165).
 *
 * RevoGrid is a Stencil bundle whose runtime lazy-imports its own component
 * entry chunks at render time. Pre-bundled into `.vite/deps`, those dynamic
 * imports are emitted without a `?v=` query, so Vite re-transforms the entry on
 * demand and stamps its `chunk-*.js` import with the browserHash current at
 * *that* moment -- while the already-loaded page graph stays pinned to the hash
 * it loaded with. One dep re-optimization between page load and the grid's
 * first mount is enough to give the page two copies of the Stencil runtime.
 *
 * Stencil decides "is this render result the host element?" with an identity
 * check (`node.$tag$ === Host`, where `Host` is a module-scoped `{}`). Two
 * runtimes fail that check, so the whole component tree is created as an
 * element literally named `[object Object]`, `createElementNS` throws, and the
 * tracker grid renders blank.
 *
 * Serving RevoGrid unbundled keeps every one of its imports in a single module
 * graph. Moving it back into `include` silently reintroduces the blank grid, so
 * assert the policy here rather than rediscovering it from a half-patched DOM.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const CONFIG_PATH = path.resolve(__dirname, '../../electron.vite.config.ts');

/** Extract the string literals of a bracket-matched array following `key:`. */
function readStringArray(source: string, key: string, searchFrom: number): string[] {
  const keyIndex = source.indexOf(`${key}: [`, searchFrom);
  if (keyIndex === -1) throw new Error(`Could not find "${key}: [" in the Vite config`);

  const open = source.indexOf('[', keyIndex);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`Unterminated array for "${key}" in the Vite config`);

  // Comments in this block mention package names in prose; only quoted
  // literals are real entries, so strip line comments before matching.
  const body = source
    .slice(open, close)
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

describe('renderer optimizeDeps policy', () => {
  const source = readFileSync(CONFIG_PATH, 'utf8');
  const optimizeDepsIndex = source.indexOf('optimizeDeps: {');
  const include = readStringArray(source, 'include', optimizeDepsIndex);
  const exclude = readStringArray(source, 'exclude', optimizeDepsIndex);

  const REVOGRID_PACKAGES = ['@revolist/react-datagrid', '@revolist/revogrid'];

  it.each(REVOGRID_PACKAGES)('excludes %s from dep pre-bundling', pkg => {
    expect(exclude).toContain(pkg);
  });

  it.each(REVOGRID_PACKAGES)('never pre-bundles %s via include', pkg => {
    expect(include).not.toContain(pkg);
  });

  it('parsed both arrays from the renderer optimizeDeps block', () => {
    // Cheap sanity check: a silently-empty parse would make the assertions
    // above pass for the wrong reason.
    expect(include.length).toBeGreaterThan(50);
    expect(exclude).toContain('@nimbalyst/runtime');
  });
});
