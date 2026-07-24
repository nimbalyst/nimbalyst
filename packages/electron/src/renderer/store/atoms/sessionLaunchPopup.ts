import { atom } from 'jotai';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { EffortLevel, ThinkingMode } from '../../utils/modelUtils';

export interface SessionLaunchDraft {
  value: string;
  attachments: ChatAttachment[];
  model: string | null;
  mode: 'agent' | 'planning';
  effortLevel: EffortLevel | null;
  thinkingMode: ThinkingMode;
  pendingSessionId: string | null;
}

export function createEmptySessionLaunchDraft(): SessionLaunchDraft {
  return {
    value: '',
    attachments: [],
    model: null,
    mode: 'agent',
    effortLevel: null,
    thinkingMode: 'enabled',
    pendingSessionId: null,
  };
}

/** Transient, workspace-scoped composer state. It intentionally is not persisted. */
export const sessionLaunchDraftAtom = atomFamily((_workspacePath: string) =>
  atom<SessionLaunchDraft>(createEmptySessionLaunchDraft()),
);
