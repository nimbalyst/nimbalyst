/**
 * Canonical helpers for the collab sync server URLs.
 *
 * In dev mode, the user can point at a locally-running worker by setting
 * `sessionSync.environment = 'development'` in the app settings store; we
 * still default to production so a dev build that hasn't explicitly opted
 * in keeps talking to `sync.nimbalyst.com`.
 *
 * Past incident (NIM-639): `MainBodyDocService` carried its own copy of
 * this helper that keyed only on `process.env.NODE_ENV !== 'production'`
 * and unconditionally returned `ws://localhost:8790` in dev. Every shared
 * `tracker_create` with a description then looped on a localhost WS the
 * user wasn't running, burning retries forever. Anything that needs the
 * collab server URL in main MUST import from here -- do not re-derive.
 */

import { getSessionSyncConfig } from './store';

const PRODUCTION_WS_URL = 'wss://sync.nimbalyst.com';
const DEVELOPMENT_WS_URL = 'ws://localhost:8790';

export function getCollabSyncWsUrl(): string {
  const config = getSessionSyncConfig();
  const isDev = process.env.NODE_ENV !== 'production';
  const env = isDev ? config?.environment : undefined;
  return env === 'development' ? DEVELOPMENT_WS_URL : PRODUCTION_WS_URL;
}

export function getCollabSyncHttpUrl(): string {
  const wsUrl = getCollabSyncWsUrl();
  return wsUrl.replace('wss://', 'https://').replace('ws://', 'http://');
}
