/**
 * Policy tests for backend-module provenance.
 *
 * Policy: installing an extension and consenting to its native-code prompt IS
 * the trust decision. No provenance-based gate refuses a backend module -- the
 * first-use consent prompt is the single control. These tests pin that: ANY
 * extension (built-in, marketplace, dev symlink, or plain user-installed) is
 * permitted to contribute backend modules, in dev and in packaged builds.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/backendModuleAllowlist.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { isAllowedToContributeBackendModules } from '../backendModuleAllowlist';

describe('isAllowedToContributeBackendModules', () => {
  it('allows a plain user-installed extension (no allowlist, no env flag)', () => {
    const result = isAllowedToContributeBackendModules({
      extensionId: 'com.example.random',
      isBuiltin: false,
      isSymlink: false,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows a dev-symlinked extension without NIMBALYST_ALLOW_DEV_BACKEND_MODULES', () => {
    const prev = process.env.NIMBALYST_ALLOW_DEV_BACKEND_MODULES;
    delete process.env.NIMBALYST_ALLOW_DEV_BACKEND_MODULES;
    try {
      const result = isAllowedToContributeBackendModules({
        extensionId: 'com.example.dev',
        isBuiltin: false,
        isSymlink: true,
      });
      expect(result.allowed).toBe(true);
    } finally {
      if (prev !== undefined) process.env.NIMBALYST_ALLOW_DEV_BACKEND_MODULES = prev;
    }
  });

  it('still identifies built-in extensions as such', () => {
    const result = isAllowedToContributeBackendModules({
      extensionId: 'com.nimbalyst.memory',
      isBuiltin: true,
      isSymlink: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('builtin');
  });
});
