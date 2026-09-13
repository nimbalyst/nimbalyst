// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const { locations, relocateClaudeRuntime, validateClaudeRuntime } = createRequire(import.meta.url)('../claude-runtime.js');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('#1476 packaged Claude layout', () => {
  it.each(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'])('%s retains one executable and its SDK manifest', target => {
    const [platform, arch] = target.split('-');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pack-')); roots.push(root);
    const { legacy, destination, manifest } = locations(root, platform, arch);
    expect(() => relocateClaudeRuntime(root, platform, arch)).toThrow();
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(legacy, 'pinned bytes', { mode: 0o755 });
    fs.writeFileSync(manifest, JSON.stringify({ platforms: { [target]: { binary: path.basename(legacy), size: 12, checksum: 'a'.repeat(64) } } }));
    expect(() => validateClaudeRuntime(root, platform, arch)).toThrow();
    expect(relocateClaudeRuntime(root, platform, arch)).toBe(destination);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('pinned bytes');
    expect(fs.existsSync(manifest)).toBe(true);
    expect(validateClaudeRuntime(root, platform, arch)).toBe(destination);
    if (platform !== 'win32') {
      fs.chmodSync(destination, 0o644);
      expect(() => validateClaudeRuntime(root, platform, arch)).toThrow(/Invalid packaged/);
      fs.chmodSync(destination, 0o755);
    }
    fs.writeFileSync(legacy, 'duplicate');
    expect(() => validateClaudeRuntime(root, platform, arch)).toThrow(/remains/);
  });
});
