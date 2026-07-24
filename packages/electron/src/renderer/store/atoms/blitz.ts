/**
 * Blitz event atoms.
 *
 * Updated by store/listeners/blitzListeners.ts. Components that previously
 * subscribed to `blitz:*` IPC events directly now read from these atoms.
 *
 * Each atom uses the request-atom shape (`{ version, payload }`) so consumers
 * can apply the skip-initial-mount idiom and react only to *new* events.
 */

import { atom } from 'jotai';

export interface BlitzCreatedEvent {
  version: number;
  payload: { blitzId: string; workspacePath: string };
}

export const blitzCreatedAtom = atom<BlitzCreatedEvent | null>(null);

export interface BlitzDisplayNameUpdate {
  version: number;
  payload: { blitzId: string; displayName: string };
}

export const blitzDisplayNameUpdateAtom = atom<BlitzDisplayNameUpdate | null>(null);

export interface BlitzAnalysisCreatedEvent {
  version: number;
  payload: {
    blitzId: string;
    analysisSessionId: string;
    analysisProvider?: string;
    analysisModel?: string;
    workspacePath: string;
  };
}

export const blitzAnalysisCreatedAtom = atom<BlitzAnalysisCreatedEvent | null>(null);
