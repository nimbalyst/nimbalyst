// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PINNED_EXTENSIONS, pinnedExtensionManifestDefine, pinnedExtensionUrlDefine } from '@nimbalyst/web-editors/pinned';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pinned editor mount path', () => {
  it.each([false, true])('imports the editor at its mounted URL (custom base: %s)', async (mounted) => {
    vi.resetModules();
    const root = mkdtempSync(path.join(tmpdir(), 'wiki-editor-base-'));
    roots.push(root);
    const relative = 'extensions/mindmap/1.0.0/index.mjs';
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'export const loaded = "mounted editor";');
    for (const pin of PINNED_EXTENSIONS) {
      vi.stubGlobal(pinnedExtensionUrlDefine(pin.slug), pin.slug === 'mindmap' ? (mounted ? `/${relative}` : file) : null);
      vi.stubGlobal(pinnedExtensionManifestDefine(pin.slug), pin.slug === 'mindmap' ? { id: 'mindmap' } : null);
    }
    const { loadPinnedExtensionBundle } = await import('@nimbalyst/web-editors/bundles');
    const pending = loadPinnedExtensionBundle('mindmap', mounted ? `${root}/` : undefined);
    expect(await pending).toMatchObject({ loaded: 'mounted editor' });
    expect(loadPinnedExtensionBundle('mindmap', mounted ? `${root}/` : undefined)).toBe(pending);
  });
});
