import type {
  ExtensionContext,
  ExtensionManifest,
  ExtensionModule,
} from '@nimbalyst/extension-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionLoader } from '../ExtensionLoader';
import {
  setExtensionPlatformService,
  type ExtensionPlatformService,
} from '../ExtensionPlatformService';

const manifest: ExtensionManifest = {
  id: 'com.nimbalyst.filesystem-test',
  name: 'Filesystem Test',
  version: '1.0.0',
  main: 'dist/index.js',
};

function makePlatform(
  activate: (context: ExtensionContext) => Promise<void>,
): ExtensionPlatformService {
  const module: ExtensionModule = { activate };
  return {
    getExtensionsDirectory: vi.fn(async () => '/extensions'),
    getAllExtensionsDirectories: vi.fn(async () => ['/extensions']),
    listDirectories: vi.fn(async () => []),
    readFile: vi.fn(async (filePath: string) => (
      filePath.endsWith('manifest.json') ? JSON.stringify(manifest) : ''
    )),
    writeFile: vi.fn(async () => undefined),
    fileExists: vi.fn(async () => true),
    loadModule: vi.fn(async () => module),
    injectStyles: vi.fn(() => () => undefined),
    resolvePath: (root: string, relative: string) => `${root}/${relative}`,
    findFiles: vi.fn(async () => []),
    isExtensionVisibleForChannel: vi.fn(async () => true),
  };
}

describe('ExtensionLoader filesystem service', () => {
  it('passes binary writes to the platform service unchanged', async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x41]);
    const platform = makePlatform(async (context) => {
      await context.services.filesystem.writeFile('/workspace/model.3mf', bytes);
    });
    setExtensionPlatformService(platform);

    const result = await new ExtensionLoader().loadExtensionFromPath('/extensions/test');

    expect(result.success).toBe(true);
    expect(platform.writeFile).toHaveBeenCalledWith('/workspace/model.3mf', bytes);
  });

  it('searches the named project root instead of the window\'s first project', async () => {
    // #1299: automations in a second rail project were never found.
    const platform = makePlatform(async (context) => {
      await context.services.filesystem.findFiles('nimbalyst-local/automations/*.md', '/ws/b');
    });
    setExtensionPlatformService(platform);

    await new ExtensionLoader().loadExtensionFromPath('/extensions/test');

    expect(platform.findFiles).toHaveBeenCalledWith('/ws/b', 'nimbalyst-local/automations/*.md');
  });

  it('resolves relative paths against the window\'s current project on every call, not a cached one', async () => {
    // #1299: the first project was cached at load, so closing it from the rail
    // or switching projects left relative paths pointing at the old one.
    const projects = ['/ws/a', '/ws/b'];
    const invoke = vi.fn(async (channel: string) => (
      channel === 'extensions:get-active-project-path' ? projects.shift() : undefined
    ));
    (globalThis as any).window = { electronAPI: { invoke } };
    try {
      const platform = makePlatform(async (context) => {
        await context.services.filesystem.readFile('notes.md');
        await context.services.filesystem.readFile('notes.md');
      });
      setExtensionPlatformService(platform);

      await new ExtensionLoader().loadExtensionFromPath('/extensions/test');

      const reads = vi.mocked(platform.readFile).mock.calls.map(([path]) => path).filter((path) => path.endsWith('notes.md'));
      expect(reads).toEqual(['/ws/a/notes.md', '/ws/b/notes.md']);
    } finally {
      delete (globalThis as any).window;
    }
  });
});
