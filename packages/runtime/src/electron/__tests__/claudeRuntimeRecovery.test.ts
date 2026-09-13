// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { setHostEnvironment } from '../../host/hostEnvironment';
import { resolveNativeBinaryPath } from '../claudeCodeEnvironment';
import { recoverClaudeRuntime, preservedClaudeFiles } from '../claudeRuntimeRecovery';

let root: string;
let options: Parameters<typeof recoverClaudeRuntime>[0];
const bytes = 'exact pinned executable';
function orphan(name: string, content = bytes) {
  const file = path.join(options.legacyDir, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recovery-'));
  options = { legacyDir: path.join(root, 'legacy'), destination: path.join(root, 'claude-runtime/win32-x64/claude.exe'), manifestPath: path.join(root, 'manifest.json'), platformKey: 'win32-x64', binaryName: 'claude.exe' };
  fs.mkdirSync(options.legacyDir);
  fs.writeFileSync(options.manifestPath, JSON.stringify({ platforms: { 'win32-x64': { binary: 'claude.exe', size: Buffer.byteLength(bytes), checksum: createHash('sha256').update(bytes).digest('hex') } } }));
});
afterEach(() => { setHostEnvironment(null); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('#1476 manifest-verified recovery', () => {
  it('selects the newest exact match, preserving all mismatched, malformed and symlink artifacts', () => {
    const older = orphan('claude.exe.old.1');
    const chosen = orphan('claude.exe.old.20');
    const wrongHash = orphan('claude.exe.old.100', 'x'.repeat(bytes.length));
    const short = orphan('claude.exe.old.200', 'short');
    const malformed = orphan('claude.exe.old.999oops');
    const link = path.join(options.legacyDir, 'claude.exe.old.500'); fs.symlinkSync(older, link);
    fs.mkdirSync(path.join(options.legacyDir, 'claude.exe.old.600'));
    expect(preservedClaudeFiles(options.legacyDir, options.binaryName)).toEqual([short, wrongHash, chosen, older]);
    expect(recoverClaudeRuntime(options)).toBe(true);
    expect(fs.readFileSync(options.destination, 'utf8')).toBe(bytes);
    expect(fs.existsSync(chosen)).toBe(false);
    for (const file of [older, wrongHash, short, malformed, link]) expect(fs.existsSync(file)).toBe(true);
  });
  it.each(['missing', 'json', 'platform', 'checksum', 'size'])('refuses a %s manifest without moving the orphan', problem => {
    const candidate = orphan('claude.exe.old.1');
    if (problem === 'missing') fs.unlinkSync(options.manifestPath);
    else if (problem === 'json') fs.writeFileSync(options.manifestPath, '{');
    else {
      const manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
      if (problem === 'platform') manifest.platforms = {};
      if (problem === 'checksum') manifest.platforms['win32-x64'].checksum = 'invalid';
      if (problem === 'size') manifest.platforms['win32-x64'].size = 0;
      fs.writeFileSync(options.manifestPath, JSON.stringify(manifest));
    }
    expect(recoverClaudeRuntime(options)).toBe(false);
    expect(fs.existsSync(candidate)).toBe(true);
    expect(fs.existsSync(options.destination)).toBe(false);
  });
  it('does not overwrite a destination published between verification and link', () => {
    const candidate = orphan('claude.exe.old.1');
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      fs.writeFileSync(destination, 'concurrent runtime');
      return link(source, destination);
    });
    expect(recoverClaudeRuntime(options)).toBe(false);
    expect(fs.readFileSync(options.destination, 'utf8')).toBe('concurrent runtime');
    expect(fs.existsSync(candidate)).toBe(true);
  });
  it('preserves wrong-hash bytes without producing a runnable destination', () => {
    const candidate = orphan('claude.exe.old.1', 'x'.repeat(bytes.length));
    expect(recoverClaudeRuntime(options)).toBe(false);
    expect(fs.existsSync(candidate)).toBe(true);
    expect(fs.existsSync(options.destination)).toBe(false);
  });
});


describe('#1476 packaged resolver integration', () => {
  it('prefers relocation, retains legacy compatibility, and recovers before returning missing', () => {
    const platformKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const resources = path.join(root, 'resources');
    const legacyDir = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai', `claude-agent-sdk-${platformKey}`);
    const manifestPath = path.join(legacyDir, '..', 'claude-agent-sdk/manifest.json');
    const canonical = path.join(resources, 'claude-runtime', platformKey, binaryName);
    const legacy = path.join(legacyDir, binaryName);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ platforms: { [platformKey]: { binary: binaryName, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') } } }));
    setHostEnvironment({ isPackaged: () => true, getAppPath: () => path.join(resources, 'app.asar') });
    fs.writeFileSync(legacy, bytes, { mode: 0o755 });
    expect(resolveNativeBinaryPath()).toBe(legacy);
    fs.renameSync(legacy, `${legacy}.old.1`);
    expect(resolveNativeBinaryPath()).toBe(canonical);
    expect(fs.existsSync(`${legacy}.old.1`)).toBe(false);
    fs.writeFileSync(legacy, 'legacy duplicate');
    expect(resolveNativeBinaryPath()).toBe(canonical);
  });
});
