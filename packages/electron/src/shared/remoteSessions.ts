import type { SessionData } from '@nimbalyst/runtime/ai/server/types';

export interface RemoteSessionSnapshot {
  session: SessionData;
  connected: boolean;
  hostOnline: boolean;
  syncing: boolean;
  executing: boolean;
  queuedPrompts: Array<{ id: string; prompt: string; timestamp: number }>;
  error?: string;
  readOnlyReason?: string;
}
