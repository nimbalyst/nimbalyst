import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The renderer resolves `@nimbalyst/extension-sdk` to `dist/`, so every file the
 * SDK build emits lives in the dev server's module graph. When the build wiped
 * dist and re-emitted all 114 files, the pre-push gate (`typecheck:prepush`,
 * which builds the SDK on every push) made Vite full-reload every open Electron
 * window -- several times an hour across parallel agent sessions, with no SDK
 * source change involved. These assertions keep the emit stable.
 */

const sdkRoot = resolve(__dirname, '../..');

function readJsonc(relativePath: string): Record<string, any> {
  const text = readFileSync(resolve(sdkRoot, relativePath), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

describe('extension-sdk build emit stability', () => {
  it('does not wipe dist on the default build', () => {
    const { scripts } = readJsonc('package.json');

    expect(scripts.build).toBe('tsc');
    expect(scripts.build).not.toMatch(/rmSync|rm -rf/);
  });

  it('emits incrementally so unchanged sources produce no file writes', () => {
    const { compilerOptions } = readJsonc('tsconfig.json');

    expect(compilerOptions.incremental).toBe(true);
    expect(compilerOptions.tsBuildInfoFile).toBeTruthy();
  });

  it('keeps a clean build available for publishing', () => {
    const { scripts } = readJsonc('package.json');

    expect(scripts['build:clean']).toMatch(/rmSync/);
    expect(scripts.prepublishOnly).toBe('npm run build:clean');
  });
});
