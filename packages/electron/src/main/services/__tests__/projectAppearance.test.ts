// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ backing: {} as Record<string, any>, dir: '', writes: 0 }));
vi.mock('electron-store', () => ({ default: class {
  path = 'mock';
  get(_key: string, fallback: unknown) { return fallback; }
  get store() { return structuredClone(state.backing); }
  set(key: string, value: unknown) { state.writes++; state.backing[key] = structuredClone(value); }
} }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir }, nativeImage: {
  createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from('thumbnail') }),
} }));
vi.mock('../../protocols/nimAssetProtocol', () => ({ addNimAssetRoot: vi.fn(), encodeNimAssetUrl: (p: string) => p }));
import { getProjectAppearance, updateProjectAppearance } from '../projectAppearance';
import { getWorkspaceState, invalidateWorkspaceStoreCache, updateWorkspaceState } from '../../utils/store';
const a = '/projects/FileRocket';
const b = '/projects/FileRocket_worktrees/fix';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
beforeEach(() => { state.backing = {}; state.writes = 0; invalidateWorkspaceStoreCache(); state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-appearance-')); });
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));
describe('project appearance persistence', () => {
  it('defaults old projects, keeps worktrees independent, and survives a store reload', () => {
    updateWorkspaceState(a, s => { s.sidebarWidth = 333; });
    expect(getProjectAppearance(a).appearance).toEqual({});
    updateProjectAppearance(a, { initials: 'FR', color: '#12ABef' });
    invalidateWorkspaceStoreCache();
    expect(getProjectAppearance(a).appearance).toMatchObject({ initials: 'FR', color: '#12abef' });
    expect(getProjectAppearance(b).appearance).toEqual({});
    expect(getWorkspaceState(a).sidebarWidth).toBe(333);
  });
  it('merges changed fields and resets overrides without deleting other settings', () => {
    updateProjectAppearance(a, { initials: 'FR' });
    updateProjectAppearance(a, { color: '#123456' });
    expect(getProjectAppearance(a).appearance).toMatchObject({ initials: 'FR', color: '#123456' });
    updateProjectAppearance(a, { initials: null, color: null, image: null });
    expect(getProjectAppearance(a).appearance).toEqual({});
  });
  it.each([['', {}], ['relative', {}], [a, { color: 'url(bad)' }], [a, { initials: 'LONG' }], [a, { image: 'file:///secret' }], [a, { imageId: '../escape' }]])('rejects invalid input without writing (%s)', (ws, patch) => {
    expect(() => updateProjectAppearance(ws as string, patch)).toThrow();
    expect(state.writes).toBe(0);
  });
  it('stores only a thumbnail reference, replaces and removes owned files', () => {
    const first = updateProjectAppearance(a, { image: png });
    const file = first.appearance.imageUrl!;
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.stringify(state.backing)).not.toContain('base64');
    const second = updateProjectAppearance(a, { image: png });
    expect(second.appearance.imageUrl).not.toBe(file);
    expect(fs.existsSync(file)).toBe(false);
    updateProjectAppearance(a, { image: null });
    expect(fs.existsSync(second.appearance.imageUrl!)).toBe(false);
  });
  it('rejects oversized PNG dimensions before decoding', () => {
    const bytes = Buffer.from(png.split(',')[1], 'base64');
    bytes.writeUInt32BE(100000, 16);
    expect(() => updateProjectAppearance(a, { image: `data:image/png;base64,${bytes.toString('base64')}` })).toThrow();
    expect(state.writes).toBe(0);
  });
});
