/**
 * Central Blitz Listeners
 *
 * Subscribes to blitz-related IPC events ONCE and routes them to atoms.
 * Components read the atoms instead of calling `electronAPI.on(...)` from
 * useEffect.
 *
 * Events handled:
 * - `blitz:created`              -> blitzCreatedAtom (request)
 * - `blitz:display-name-updated` -> blitzDisplayNameUpdateAtom (request)
 * - `blitz:analysis-created`     -> blitzAnalysisCreatedAtom (request)
 *
 * Call initBlitzListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  blitzAnalysisCreatedAtom,
  blitzCreatedAtom,
  blitzDisplayNameUpdateAtom,
} from '../atoms/blitz';

let initialized = false;

export function initBlitzListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];
  let createdVersion = 0;
  let displayNameVersion = 0;
  let analysisVersion = 0;

  const u1 = window.electronAPI?.on?.(
    'blitz:created',
    (data: { blitzId: string; workspacePath: string }) => {
      if (!data?.blitzId || !data.workspacePath) return;
      createdVersion += 1;
      store.set(blitzCreatedAtom, {
        version: createdVersion,
        payload: { blitzId: data.blitzId, workspacePath: data.workspacePath },
      });
    },
  );
  if (typeof u1 === 'function') cleanups.push(u1);

  const u2 = window.electronAPI?.on?.(
    'blitz:display-name-updated',
    (data: { blitzId: string; displayName: string }) => {
      if (!data?.blitzId) return;
      displayNameVersion += 1;
      store.set(blitzDisplayNameUpdateAtom, {
        version: displayNameVersion,
        payload: { blitzId: data.blitzId, displayName: data.displayName },
      });
    },
  );
  if (typeof u2 === 'function') cleanups.push(u2);

  const u3 = window.electronAPI?.on?.(
    'blitz:analysis-created',
    (data: {
      blitzId: string;
      analysisSessionId: string;
      analysisProvider?: string;
      analysisModel?: string;
      workspacePath: string;
    }) => {
      if (!data?.analysisSessionId || !data.workspacePath) return;
      analysisVersion += 1;
      store.set(blitzAnalysisCreatedAtom, {
        version: analysisVersion,
        payload: {
          blitzId: data.blitzId,
          analysisSessionId: data.analysisSessionId,
          analysisProvider: data.analysisProvider,
          analysisModel: data.analysisModel,
          workspacePath: data.workspacePath,
        },
      });
    },
  );
  if (typeof u3 === 'function') cleanups.push(u3);

  return () => {
    initialized = false;
    cleanups.forEach((fn) => fn?.());
  };
}
