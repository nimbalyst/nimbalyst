import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  getDevelopmentBuiltinThemesCandidates,
  resolveDevelopmentBuiltinThemesDirectory,
} from '../builtinThemesDirectory';

const builtinThemesPath = path.resolve('/repo/packages/runtime/src/themes/builtin');

describe('resolveDevelopmentBuiltinThemesDirectory', () => {
  it('resolves themes beside the Electron package for the normal dev entry', async () => {
    const exists = vi.fn(async (candidate: string) => candidate === builtinThemesPath);

    await expect(
      resolveDevelopmentBuiltinThemesDirectory('/repo/packages/electron', exists),
    ).resolves.toBe(builtinThemesPath);
  });

  it('walks above an isolated electron-vite output directory', async () => {
    const exists = vi.fn(async (candidate: string) => candidate === builtinThemesPath);

    await expect(
      resolveDevelopmentBuiltinThemesDirectory('/repo/packages/electron/out2/main', exists),
    ).resolves.toBe(builtinThemesPath);

    expect(exists).toHaveBeenCalledWith(
      path.resolve('/repo/packages/electron/out2/runtime/src/themes/builtin'),
    );
    expect(exists).toHaveBeenCalledWith(builtinThemesPath);
  });

  it('falls back to the normal candidate when none exist', async () => {
    const appPath = '/repo/packages/electron';
    const candidates = getDevelopmentBuiltinThemesCandidates(appPath);

    await expect(
      resolveDevelopmentBuiltinThemesDirectory(appPath, async () => false),
    ).resolves.toBe(candidates[0]);
  });
});
