import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import * as fs from 'fs';
import { getRestartSignalPath } from '../utils/appPaths';

export type SafeRestartResult = {
  ok: true;
  action: 'restarting' | 'ui-reloaded';
  alreadyScheduled: boolean;
  busySessionIds: string[];
  requestedAt: number;
  source: string;
  message: string;
  reloadedWindowCount?: number;
};

export function getBusyRestartSessionIds(): string[] {
  const stateManager = getSessionStateManager();
  const activeSessionIds = stateManager.getTrackedSessionIds();

  return activeSessionIds.filter((sessionId: string) => {
    const state = stateManager.getSessionState(sessionId);
    return state && (
      state.status === 'running' ||
      state.status === 'waiting_for_input' ||
      state.isStreaming === true
    );
  });
}

async function saveSessionStateSnapshot(source: string): Promise<void> {
  try {
    const { saveSessionState } = await import('../session/SessionState');
    await saveSessionState();
    console.log(`[SafeRestart] Saved session state snapshot (${source})`);
  } catch (error) {
    console.error(`[SafeRestart] Failed to save session state snapshot (${source}):`, error);
  }
}

async function saveSessionStateForRestart(source: string): Promise<void> {
  try {
    const { setRestarting } = await import('../index');
    setRestarting(true);
  } catch (error) {
    console.error(`[SafeRestart] Failed to mark app as restarting (${source}):`, error);
  }
  await saveSessionStateSnapshot(source);
}

async function performNimbalystRestart(reason: string, source: string): Promise<void> {
  const { app } = await import('electron');

  console.log(`[SafeRestart] Restarting Nimbalyst (${reason}, source=${source})`);
  await saveSessionStateForRestart(source);

  const isDev =
    process.env.NODE_ENV === 'development' ||
    !!process.env.ELECTRON_RENDERER_URL;

  if (isDev) {
    const restartSignalPath = getRestartSignalPath();
    console.log(`[SafeRestart] Dev mode restart: writing signal to ${restartSignalPath}`);
    fs.writeFileSync(restartSignalPath, Date.now().toString(), 'utf8');
    setTimeout(() => {
      app.quit();
    }, 100);
    return;
  }

  // Use quit(), not exit(), so normal cleanup and database shutdown run.
  app.relaunch();
  app.quit();
}

async function reloadNimbalystWindows(source: string): Promise<number> {
  const { BrowserWindow } = await import('electron');
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());

  console.log(`[SafeRestart] Reloading ${windows.length} window(s) without relaunching main (source=${source})`);
  await saveSessionStateSnapshot(source);

  for (const window of windows) {
    try {
      if (window.webContents.isDestroyed()) {
        continue;
      }
      window.webContents.reloadIgnoringCache();
    } catch (error) {
      console.error('[SafeRestart] Failed to reload window:', error);
    }
  }

  return windows.length;
}

export async function restartNimbalystSafely(
  source = 'mcp'
): Promise<SafeRestartResult> {
  const busySessionIds = getBusyRestartSessionIds();
  const now = Date.now();

  if (busySessionIds.length > 0) {
    const reloadedWindowCount = await reloadNimbalystWindows(source);
    return {
      ok: true,
      action: 'ui-reloaded',
      alreadyScheduled: false,
      busySessionIds,
      requestedAt: now,
      source,
      reloadedWindowCount,
      message: `Reloaded ${reloadedWindowCount} Nimbalyst window(s) without relaunching main, preserving ${busySessionIds.length} active session(s).`,
    };
  }

  await performNimbalystRestart('no active sessions are busy', source);
  return {
    ok: true,
    action: 'restarting',
    alreadyScheduled: false,
    busySessionIds: [],
    requestedAt: now,
    source,
    message: 'Restarting Nimbalyst now; no active sessions are busy.',
  };
}
