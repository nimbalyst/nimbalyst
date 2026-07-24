/**
 * Concurrent prompts for the SAME backend module must coalesce onto a single
 * dialog. At startup every open workspace tries to start the module and each
 * runStartAttempt raises a prompt; without coalescing the user sees one dialog
 * per workspace. These tests pin that a module raises at most one live dialog
 * regardless of how many workspaces ask, and that all waiters share its result.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/permissionPrompt.coalesce.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import {
  raisePermissionPrompt,
  setPermissionPromptResolver,
  type PermissionPromptRequest,
  type PermissionPromptResolution,
} from '../permissionPrompt';

function req(overrides: Partial<PermissionPromptRequest> = {}): PermissionPromptRequest {
  return {
    id: `id-${Math.random()}`,
    extensionId: 'com.example.jupyter',
    extensionName: 'Jupyter',
    moduleId: 'jupyter-runtime',
    purpose: 'Run kernels',
    declaredPermissions: [],
    workspacePath: '/ws/a',
    reason: { kind: 'first-use' },
    raisedAt: 0,
    ...overrides,
  };
}

afterEach(() => setPermissionPromptResolver(null));

describe('raisePermissionPrompt coalescing', () => {
  it('collapses concurrent prompts for the same module into one resolver call', async () => {
    let release!: (r: PermissionPromptResolution) => void;
    const calls: PermissionPromptRequest[] = [];
    setPermissionPromptResolver((r) => {
      calls.push(r);
      return new Promise<PermissionPromptResolution>((resolve) => {
        release = resolve;
      });
    });

    const a = raisePermissionPrompt(req({ workspacePath: '/ws/a' }));
    const b = raisePermissionPrompt(req({ workspacePath: '/ws/b' }));
    const c = raisePermissionPrompt(req({ workspacePath: '/ws/c' }));

    release({ decision: 'enable-global' });
    const results = await Promise.all([a, b, c]);

    expect(calls).toHaveLength(1);
    expect(results).toEqual([
      { decision: 'enable-global' },
      { decision: 'enable-global' },
      { decision: 'enable-global' },
    ]);
  });

  it('does not coalesce different modules', async () => {
    const calls: PermissionPromptRequest[] = [];
    setPermissionPromptResolver(async (r) => {
      calls.push(r);
      return { decision: 'enable-global' };
    });

    await Promise.all([
      raisePermissionPrompt(req({ moduleId: 'mod-a' })),
      raisePermissionPrompt(req({ moduleId: 'mod-b' })),
    ]);

    expect(calls).toHaveLength(2);
  });

  it('re-raises after the prior dialog resolved', async () => {
    let calls = 0;
    setPermissionPromptResolver(async () => {
      calls++;
      return { decision: 'not-now' };
    });

    await raisePermissionPrompt(req());
    await raisePermissionPrompt(req());

    expect(calls).toBe(2);
  });
});
