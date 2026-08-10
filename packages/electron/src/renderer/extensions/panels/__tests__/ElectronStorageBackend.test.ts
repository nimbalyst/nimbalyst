// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExtensionStorageState = Record<string, unknown>;

interface MockWorkspaceState {
  extensionStorage?: ExtensionStorageState;
  [key: string]: unknown;
}

function deepMerge(target: Record<string, unknown>, source: unknown): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (
      sourceValue
      && typeof sourceValue === 'object'
      && !Array.isArray(sourceValue)
      && targetValue
      && typeof targetValue === 'object'
      && !Array.isArray(targetValue)
    ) {
      deepMerge(targetValue as Record<string, unknown>, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}

function installWorkspaceStateHarness(
  initialState: MockWorkspaceState = {},
  options: { failWorkspaceReads?: number } = {},
) {
  let workspaceState: MockWorkspaceState = structuredClone(initialState);
  let remainingWorkspaceReadFailures = options.failWorkspaceReads ?? 0;

  // Deliberately accepts only the real handler arguments after the channel:
  // (workspacePath, updates). Any third handler argument is ignored by JS,
  // matching WorkspaceHandlers' current callback signature.
  const invoke = vi.fn(async (
    channel: string,
    _workspacePathOrKey?: string,
    updates?: unknown,
  ) => {
    if (channel === 'workspace:get-state') {
      if (remainingWorkspaceReadFailures > 0) {
        remainingWorkspaceReadFailures -= 1;
        throw new Error('Transient workspace read failure');
      }
      return structuredClone(workspaceState);
    }
    if (channel === 'workspace:update-state') {
      if (
        updates
        && typeof updates === 'object'
        && !Array.isArray(updates)
        && Object.prototype.hasOwnProperty.call(updates, 'extensionStorage')
      ) {
        const { extensionStorage, ...remainingUpdates } = updates as MockWorkspaceState;
        deepMerge(workspaceState, remainingUpdates);
        workspaceState.extensionStorage = structuredClone(extensionStorage ?? {});
      } else {
        deepMerge(workspaceState, updates);
      }
      return undefined;
    }
    if (channel === 'app-settings:get') return {};
    throw new Error(`Unexpected IPC channel: ${channel}`);
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { invoke } },
  });

  return {
    getWorkspaceState: () => structuredClone(workspaceState),
  };
}

async function settleInitialization(
  initialize: (workspacePath: string | null) => void | Promise<void>,
): Promise<void> {
  await initialize('/workspace');
  await Promise.resolve();
}

describe('ElectronStorageBackend workspace persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, 'window');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('round-trips a workspace value through the real workspace-state IPC shape', async () => {
    const harness = installWorkspaceStateHarness({ unrelatedWorkspaceState: true });
    const { electronStorageBackend, initializeElectronStorageBackend } = await import('../ElectronStorageBackend');

    await settleInitialization(initializeElectronStorageBackend);
    await electronStorageBackend.setWorkspace('k', { enabled: true });
    await settleInitialization(initializeElectronStorageBackend);

    expect(electronStorageBackend.getWorkspace('k')).toEqual({ enabled: true });
    expect(harness.getWorkspaceState()).toMatchObject({
      unrelatedWorkspaceState: true,
      extensionStorage: { k: { enabled: true } },
    });
  });

  it('removes a workspace key without disturbing other extension storage', async () => {
    const harness = installWorkspaceStateHarness({
      extensionStorage: { k: 'remove me', keep: 'keep me' },
    });
    const { electronStorageBackend, initializeElectronStorageBackend } = await import('../ElectronStorageBackend');

    await settleInitialization(initializeElectronStorageBackend);
    expect(electronStorageBackend.getWorkspace('k')).toBe('remove me');

    await electronStorageBackend.deleteWorkspace('k');
    await settleInitialization(initializeElectronStorageBackend);

    expect(electronStorageBackend.getWorkspace('k')).toBeUndefined();
    expect(electronStorageBackend.getWorkspace('keep')).toBe('keep me');
    expect(harness.getWorkspaceState().extensionStorage).toEqual({ keep: 'keep me' });
  });

  it('refuses to overwrite extension storage after workspace hydration fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = installWorkspaceStateHarness(
      { extensionStorage: { existing: 'preserve me' } },
      { failWorkspaceReads: 1 },
    );
    const { electronStorageBackend, initializeElectronStorageBackend } = await import('../ElectronStorageBackend');

    await settleInitialization(initializeElectronStorageBackend);

    await expect(electronStorageBackend.setWorkspace('new-key', 'new value')).rejects.toThrow(
      'Cannot save workspace storage before it has loaded successfully',
    );
    expect(harness.getWorkspaceState().extensionStorage).toEqual({ existing: 'preserve me' });
    expect(consoleError).toHaveBeenCalledWith(
      '[ElectronStorageBackend] Failed to load workspace storage:',
      expect.any(Error),
    );
  });
});
