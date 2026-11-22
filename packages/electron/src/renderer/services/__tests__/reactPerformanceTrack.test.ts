// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Properties = Array<[string, string]>;
interface PerformanceTrack {
  addValueToProperties(name: string, value: unknown, properties: Properties, indent: number, prefix: string): void;
  addObjectToProperties(value: unknown, properties: Properties, indent: number, prefix: string): void;
  addObjectDiffToProperties(prev: unknown, next: unknown, properties: Properties, indent: number): boolean;
}

// Exercise the installed dependency, not a copy of the patched functions. Only
// expose the private diagnostics; leave their code and recursive calls intact.
// A React upgrade that removes these functions should retire/revisit the patch.
function loadPerformanceTrack(entry: string): PerformanceTrack {
  const require = createRequire(import.meta.url);
  const filename = path.join(path.dirname(require.resolve('react-dom/package.json')), 'cjs', entry);
  const source = readFileSync(filename, 'utf8');
  const exports: { performanceTrack?: PerformanceTrack } = {};
  vm.runInNewContext(source.replace(
    'function addObjectToProperties(',
    'exports.performanceTrack = { addValueToProperties, addObjectToProperties, addObjectDiffToProperties };\n    function addObjectToProperties(',
  ), { exports, require, process: { env: { NODE_ENV: 'development' } }, console, performance, setTimeout, clearTimeout }, { filename });
  if (!exports.performanceTrack) throw new Error('React performance diagnostics changed; revisit the dependency patch');
  return exports.performanceTrack;
}

describe.each(['react-dom-client.development.js', 'react-dom-profiling.development.js'])('%s diagnostics', (entry) => {
  const track = loadPerformanceTrack(entry);
  const denied = () => { throw new DOMException('Blocked a cross-origin frame', 'SecurityError'); };

  it('records an unreadable value without throwing and continues logging sibling props', () => {
    const frame = new Proxy({}, { get: denied });
    const properties: Properties = [];
    track.addObjectToProperties({ frame, count: 2 }, properties, 0, '');
    expect(properties).toContainEqual(['frame', '[Unreadable value]']);
    expect(properties).toContainEqual(['count', '2']);
  });

  it('contains failures while enumerating a nested host object', () => {
    const properties: Properties = [];
    track.addObjectToProperties(new Proxy({}, { ownKeys: denied }), properties, 0, '');
    expect(properties).toContainEqual(['…', '[Unreadable properties]']);
  });

  it.each(['get', 'has', 'ownKeys'] as const)('contains %s failures in prop diffing and reports the diff as unknown/changed', (operation) => {
    const properties: Properties = [];
    const next = new Proxy({ frame: {} }, { [operation]: denied });
    expect(track.addObjectDiffToProperties({ frame: null }, next, properties, 0)).toBe(false);
    expect(properties).toContainEqual(['…', '[Unreadable prop diff]']);
  });

  it('still reports ordinary changed and unchanged props', () => {
    const properties: Properties = [];
    expect(track.addObjectDiffToProperties({ count: 1 }, { count: 2 }, properties, 0)).toBe(false);
    expect(properties.map((entry) => entry[1])).toEqual(['1', '2']);
    expect(track.addObjectDiffToProperties({ count: 1 }, { count: 1 }, [], 0)).toBe(true);
  });
});
