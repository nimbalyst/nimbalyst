import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveSingleInstanceLifecycleOwnership,
  runIfSingleInstanceLifecycleOwner,
  startLosingSecondaryControlPath,
} from '../singleInstanceLifecycle';

describe('single-instance lifecycle ownership', () => {
  it('keeps multiple-instance development and test processes as lifecycle owners', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: true,
      acquiredSingleInstanceLock: null,
    });

    expect(ownership).toEqual({
      mode: 'multiple-instance-owner',
      ownsPrimaryLifecycle: true,
    });
  });

  it('makes the packaged lock winner the primary lifecycle owner', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: false,
      acquiredSingleInstanceLock: true,
    });

    expect(ownership).toEqual({
      mode: 'single-instance-primary',
      ownsPrimaryLifecycle: true,
    });
  });

  it('denies both initialization and cleanup ownership to a packaged lock loser', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: false,
      acquiredSingleInstanceLock: false,
    });

    expect(ownership).toEqual({
      mode: 'single-instance-secondary',
      ownsPrimaryLifecycle: false,
    });
  });

  it('requires an explicit lock result for packaged single-instance processes', () => {
    expect(() =>
      resolveSingleInstanceLifecycleOwnership({
        allowMultipleInstances: false,
        acquiredSingleInstanceLock: null,
      }),
    ).toThrow('Packaged single-instance lifecycle requires a lock result');
  });
});

describe('single-instance lifecycle effect gate', () => {
  it('initializes and cleans up a winning primary exactly once per requested lifecycle step', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: false,
      acquiredSingleInstanceLock: true,
    });
    const writeDescriptor = vi.fn();
    const initializePrimary = vi.fn(() => writeDescriptor());
    const removeDescriptor = vi.fn();
    const cleanupPrimary = vi.fn(() => removeDescriptor());

    expect(runIfSingleInstanceLifecycleOwner(ownership, initializePrimary)).toBe(true);
    expect(runIfSingleInstanceLifecycleOwner(ownership, cleanupPrimary)).toBe(true);
    expect(initializePrimary).toHaveBeenCalledOnce();
    expect(writeDescriptor).toHaveBeenCalledOnce();
    expect(cleanupPrimary).toHaveBeenCalledOnce();
    expect(removeDescriptor).toHaveBeenCalledOnce();
  });

  it('keeps every primary initialization and cleanup side effect out of a losing secondary', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: false,
      acquiredSingleInstanceLock: false,
    });
    const primaryEffects = {
      initializePrimary: vi.fn(),
      writeDescriptor: vi.fn(),
      removeDescriptor: vi.fn(),
      stopMcpServer: vi.fn(),
      stopSessionWakeScheduler: vi.fn(),
      stopFileWatchers: vi.fn(),
      stopWorkspaceWatchers: vi.fn(),
      closeSharedSessionState: vi.fn(),
      closeSharedDatabase: vi.fn(),
    };

    const initialized = runIfSingleInstanceLifecycleOwner(ownership, () => {
      primaryEffects.initializePrimary();
      primaryEffects.writeDescriptor();
    });
    const cleanedUp = runIfSingleInstanceLifecycleOwner(ownership, () => {
      primaryEffects.stopMcpServer();
      primaryEffects.stopSessionWakeScheduler();
      primaryEffects.stopFileWatchers();
      primaryEffects.stopWorkspaceWatchers();
      primaryEffects.closeSharedSessionState();
      primaryEffects.closeSharedDatabase();
      primaryEffects.removeDescriptor();
    });

    expect(initialized).toBe(false);
    expect(cleanedUp).toBe(false);
    for (const effect of Object.values(primaryEffects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  });
});

describe('main-process lifecycle wiring', () => {
  it('retains ownership across lock acquisition, readiness, and before-quit cleanup', () => {
    const indexSource = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    );

    expect(indexSource).toContain(
      'const singleInstanceLifecycle = resolveSingleInstanceLifecycleOwnership({',
    );
    expect(indexSource).toMatch(
      /runIfSingleInstanceLifecycleOwner\(singleInstanceLifecycle, \(\) => \{\s+void app\.whenReady\(\)\.then/,
    );
    expect(indexSource).toMatch(
      /app\.on\('before-quit', async \(event\) => \{\s+if \(!singleInstanceLifecycle\.ownsPrimaryLifecycle\) \{[\s\S]*?return;\s+\}\s+getCollabOutboxDrainCoordinator\(\)\.stop\(\)/,
    );
  });
});

describe('losing-secondary relay and exit path (no Electron process)', () => {
  function createHarness(argv: string[]) {
    let openFileHandler: ((filePath: string) => void) | null = null;
    let timeoutHandler: (() => void) | null = null;
    const relayFile = vi.fn();
    const quit = vi.fn();
    const onDeepLinkExit = vi.fn();
    const onTimeoutExit = vi.fn();

    const result = startLosingSecondaryControlPath({
      argv,
      isAbsolutePath: (candidate) => /^[A-Z]:\\/i.test(candidate),
      relayFile,
      registerOpenFileHandler: (handler) => {
        openFileHandler = handler;
      },
      scheduleExitTimeout: (handler, delayMs) => {
        expect(delayMs).toBe(5000);
        timeoutHandler = handler;
      },
      quit,
      onDeepLinkExit,
      onTimeoutExit,
    });

    return {
      result,
      relayFile,
      quit,
      onDeepLinkExit,
      onTimeoutExit,
      emitOpenFile: (filePath: string) => openFileHandler?.(filePath),
      expireTimeout: () => timeoutHandler?.(),
    };
  }

  it('relays an absolute argv file and exits immediately', () => {
    const harness = createHarness(['Nimbalyst.exe', 'D:\\project\\note.md']);

    expect(harness.result).toBe('relayed-argv-file');
    expect(harness.relayFile).toHaveBeenCalledOnce();
    expect(harness.relayFile).toHaveBeenCalledWith('D:\\project\\note.md');
    expect(harness.quit).toHaveBeenCalledOnce();
  });

  it('exits immediately for a deep link already forwarded by Electron', () => {
    const harness = createHarness(['Nimbalyst.exe', 'nimbalyst://doc/abc']);

    expect(harness.result).toBe('deep-link-exit');
    expect(harness.onDeepLinkExit).toHaveBeenCalledOnce();
    expect(harness.relayFile).not.toHaveBeenCalled();
    expect(harness.quit).toHaveBeenCalledOnce();
  });

  it('waits for an OS open-file event, relays it, and does not exit twice on timeout', () => {
    const harness = createHarness(['Nimbalyst.exe']);

    expect(harness.result).toBe('waiting-for-open-file');
    expect(harness.quit).not.toHaveBeenCalled();

    harness.emitOpenFile('D:\\project\\from-shell.md');
    harness.expireTimeout();

    expect(harness.relayFile).toHaveBeenCalledOnce();
    expect(harness.relayFile).toHaveBeenCalledWith('D:\\project\\from-shell.md');
    expect(harness.onTimeoutExit).not.toHaveBeenCalled();
    expect(harness.quit).toHaveBeenCalledOnce();
  });

  it('exits after the bounded wait when no OS open-file event arrives', () => {
    const harness = createHarness(['Nimbalyst.exe']);

    harness.expireTimeout();

    expect(harness.relayFile).not.toHaveBeenCalled();
    expect(harness.onTimeoutExit).toHaveBeenCalledOnce();
    expect(harness.quit).toHaveBeenCalledOnce();
  });

  it('waits and exits without initializing or cleaning up shared primary state', () => {
    const ownership = resolveSingleInstanceLifecycleOwnership({
      allowMultipleInstances: false,
      acquiredSingleInstanceLock: false,
    });
    const initializePrimary = vi.fn();
    const cleanupPrimary = vi.fn();
    const writeDescriptor = vi.fn();
    const removeDescriptor = vi.fn();
    const stopMcpServer = vi.fn();
    const stopSessionWakeScheduler = vi.fn();
    const stopFileWatchers = vi.fn();
    const stopWorkspaceWatchers = vi.fn();
    const closeSharedSessionState = vi.fn();
    const closeSharedDatabase = vi.fn();
    const harness = createHarness(['Nimbalyst.exe']);

    runIfSingleInstanceLifecycleOwner(ownership, () => {
      initializePrimary();
      writeDescriptor();
    });
    harness.expireTimeout();
    runIfSingleInstanceLifecycleOwner(ownership, () => {
      cleanupPrimary();
      removeDescriptor();
      stopMcpServer();
      stopSessionWakeScheduler();
      stopFileWatchers();
      stopWorkspaceWatchers();
      closeSharedSessionState();
      closeSharedDatabase();
    });

    expect(harness.result).toBe('waiting-for-open-file');
    expect(harness.quit).toHaveBeenCalledOnce();
    for (const primaryEffect of [
      initializePrimary,
      cleanupPrimary,
      writeDescriptor,
      removeDescriptor,
      stopMcpServer,
      stopSessionWakeScheduler,
      stopFileWatchers,
      stopWorkspaceWatchers,
      closeSharedSessionState,
      closeSharedDatabase,
    ]) {
      expect(primaryEffect).not.toHaveBeenCalled();
    }
  });
});
