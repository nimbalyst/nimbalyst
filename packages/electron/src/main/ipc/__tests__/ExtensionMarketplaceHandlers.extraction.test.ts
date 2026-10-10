// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

interface ExtractionState {
  extensionsDir: string;
  archive: Buffer<ArrayBufferLike>;
  handlers: Map<string, (...args: any[]) => Promise<any>>;
  recordInstall: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted((): ExtractionState => ({
  extensionsDir: '',
  archive: Buffer.alloc(0),
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  recordInstall: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: async () => ({ ok: true, arrayBuffer: async () => state.archive }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class { get() { return {}; } } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => Promise<any>) => state.handlers.set(channel, handler),
}));
vi.mock('../ExtensionHandlers', () => ({
  getUserExtensionsDirectory: async () => state.extensionsDir,
  initializeExtensionFileTypes: async () => {},
}));
vi.mock('../../utils/store', () => ({ addMarketplaceInstall: state.recordInstall }));
vi.mock('../../extensions/AgentProviderRegistry', () => ({ getAgentProviderRegistry: vi.fn() }));
import { registerExtensionMarketplaceHandlers } from '../ExtensionMarketplaceHandlers';

const extensionId = 'com.example.extraction';
function archive() {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ id: extensionId, version: '1.0.0', main: 'dist/index.js' })));
  zip.addFile('dist/index.js', Buffer.from('export const value = "bounded";\n'.repeat(2048)));
  zip.addFile('empty.txt', Buffer.alloc(0));
  return zip.toBuffer();
}
function declareSize(buffer: Buffer, filename: string, size: number) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry(filename)!;
  const local = entry.header.offset;
  buffer.writeUInt32LE(size, local + 22);
  for (let offset = 0; offset < buffer.length - 46; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = buffer.readUInt16LE(offset + 28);
    if (buffer.subarray(offset + 46, offset + 46 + length).toString() === filename) {
      buffer.writeUInt32LE(size, offset + 24);
      return;
    }
  }
  throw new Error('Missing central header');
}
async function install() {
  return state.handlers.get('extension-marketplace:install')!({}, extensionId, 'https://example.test/fixture.nimext', '', '1.0.0');
}

describe('marketplace ZIP extraction', () => {
  beforeEach(async () => {
    state.extensionsDir = await mkdtemp(path.join(tmpdir(), 'nimext-extraction-'));
    state.recordInstall.mockClear();
    registerExtensionMarketplaceHandlers();
  });
  afterEach(async () => { await rm(state.extensionsDir, { recursive: true, force: true }); });

  it('installs nested and empty files through the production staging path', async () => {
    state.archive = archive();
    expect(await install()).toEqual({ success: true, extensionId });
    expect(await readFile(path.join(state.extensionsDir, extensionId, 'dist/index.js'), 'utf8')).toContain('bounded');
    expect((await readFile(path.join(state.extensionsDir, extensionId, 'empty.txt'))).length).toBe(0);
    expect(await readdir(state.extensionsDir)).toEqual([extensionId]);
    expect(state.recordInstall).toHaveBeenCalledOnce();
  });

  it('rejects a compressed entry declaring zero output and preserves the installed extension', async () => {
    const installed = path.join(state.extensionsDir, extensionId);
    await mkdir(installed);
    await writeFile(path.join(installed, 'sentinel.txt'), 'existing installation');
    state.archive = archive();
    declareSize(state.archive, 'dist/index.js', 0);
    const result = await install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a valid Nimbalyst extension archive');
    expect(await readFile(path.join(installed, 'sentinel.txt'), 'utf8')).toBe('existing installation');
    expect(await readdir(state.extensionsDir)).toEqual([extensionId]);
    expect(state.recordInstall).not.toHaveBeenCalled();
  });
});
