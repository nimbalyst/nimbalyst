import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type {
  AwarenessState,
  DocumentSyncStatus,
} from '@nimbalyst/runtime/sync/documentSyncTypes';
import type { Doc } from 'yjs';

import type {
  CollabEditorParticipant,
  CollabEditorPresence,
  CollabEditorUser,
  ResolvedCollabEditorUser,
} from './types';

const CURSOR_COLORS = [
  '#E05555', '#2BA89A', '#3A8FD6', '#D97706',
  '#9B59B6', '#E06B8F', '#3B82F6', '#16A34A',
] as const;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

interface BundlePresenceMetadata {
  version: 1;
  updatedAt: number;
}

type PresenceAwareUserState = AwarenessState['user'] & {
  nimbalystPresence?: BundlePresenceMetadata;
};

export interface AwarenessSyncSurface {
  getYDoc(): Doc;
  getStatus(): DocumentSyncStatus;
  connect(): Promise<void>;
  setLocalAwareness(state: AwarenessState): void;
  sendAwareness?(state: AwarenessState): Promise<void>;
  sendAwarenessDeparture(user: AwarenessState['user']): boolean;
  onAwarenessChange(listener: (states: Map<string, AwarenessState>) => void): () => void;
}

interface CollabPresenceSurfaceOptions {
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

function cursorColorForMember(memberId: TeamMemberId): string {
  let hash = 0;
  for (const character of memberId) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

/**
 * Resolve the same human identity desktop broadcasts for shared markdown:
 * roster name, then roster email, then the team-scoped member id.
 */
export function resolveCollabEditorUser(user: CollabEditorUser): ResolvedCollabEditorUser {
  const name = user.name?.trim();
  const email = user.email?.trim();
  return {
    memberId: user.memberId,
    displayName: name || email || user.memberId,
    email: email || null,
    role: user.role ?? null,
    cursorColor: user.cursorColor?.trim() || cursorColorForMember(user.memberId),
  };
}

function participantFromAwareness(
  memberId: string,
  state: AwarenessState,
): CollabEditorParticipant {
  return {
    memberId: memberId as TeamMemberId,
    displayName: state.user.name?.trim() || memberId,
    cursorColor: state.user.color,
    hasSelection: Boolean(state.cursor),
  };
}

function participantFingerprint(participants: CollabEditorParticipant[]): string {
  return participants.map((participant) => (
    `${participant.memberId}\u0000${participant.displayName}\u0000${participant.cursorColor}`
    + `\u0000${participant.hasSelection ? '1' : '0'}`
  )).join('\u0001');
}

/**
 * Awareness facade used by the existing CollabLexicalProvider bridge.
 *
 * It adds a browser/WebView heartbeat to the existing awareness payload and
 * filters expired bundle peers before both Lexical and the host see them.
 * Legacy desktop awareness has no heartbeat metadata and continues to use
 * DocumentSync's existing stale-state cleanup.
 */
export class CollabPresenceSurface implements AwarenessSyncSurface {
  private readonly awarenessListeners = new Set<(
    states: Map<string, AwarenessState>,
  ) => void>();
  private readonly presenceListeners = new Set<(
    presence: CollabEditorPresence,
  ) => void>();
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly unsubscribeDelegate: () => void;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private localState: AwarenessState | null = null;
  private remoteStates = new Map<string, AwarenessState>();
  private lastPresenceFingerprint = '';
  private active = true;
  private destroyed = false;

  constructor(
    private readonly delegate: AwarenessSyncSurface,
    options: CollabPresenceSurfaceOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.unsubscribeDelegate = delegate.onAwarenessChange((states) => {
      this.remoteStates = new Map(states);
      this.emitAwarenessAndPresence();
    });
    this.sweepTimer = setInterval(
      () => this.emitAwarenessAndPresence(),
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
  }

  getYDoc(): Doc {
    return this.delegate.getYDoc();
  }

  getStatus(): DocumentSyncStatus {
    return this.delegate.getStatus();
  }

  connect(): Promise<void> {
    return this.delegate.connect();
  }

  setLocalAwareness(state: AwarenessState): void {
    if (this.destroyed) return;
    this.localState = this.withFreshness(state);
    if (!this.active) return;
    this.delegate.setLocalAwareness(this.localState);
    this.startHeartbeat();
  }

  sendAwarenessDeparture(user: AwarenessState['user']): boolean {
    return this.deactivate(user);
  }

  /** Toggle whether this mounted editor is currently present in the room. */
  setActive(active: boolean): boolean {
    if (this.destroyed || this.active === active) return false;
    if (!active) return this.deactivate(this.localState?.user);

    this.active = true;
    if (!this.localState) return false;
    this.localState = this.withFreshness(this.localState);
    if (this.delegate.sendAwareness) {
      void this.delegate.sendAwareness(this.localState);
    } else {
      this.delegate.setLocalAwareness(this.localState);
    }
    this.startHeartbeat();
    return true;
  }

  onAwarenessChange(
    listener: (states: Map<string, AwarenessState>) => void,
  ): () => void {
    this.awarenessListeners.add(listener);
    return () => this.awarenessListeners.delete(listener);
  }

  onPresenceChange(listener: (presence: CollabEditorPresence) => void): () => void {
    this.presenceListeners.add(listener);
    listener(this.getPresence());
    return () => this.presenceListeners.delete(listener);
  }

  getPresence(): CollabEditorPresence {
    const participants = [...this.getVisibleStates().entries()]
      .map(([memberId, state]) => participantFromAwareness(memberId, state))
      .sort((left, right) => (
        left.displayName.localeCompare(right.displayName)
        || left.memberId.localeCompare(right.memberId)
      ));
    return { participants };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.deactivate(this.localState?.user);
    this.destroyed = true;
    this.unsubscribeDelegate();
    clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.awarenessListeners.clear();
    this.presenceListeners.clear();
    this.remoteStates.clear();
  }

  private withFreshness(state: AwarenessState): AwarenessState {
    return {
      ...state,
      user: {
        ...state.user,
        nimbalystPresence: {
          version: 1,
          updatedAt: this.now(),
        },
      } satisfies PresenceAwareUserState,
    };
  }

  private deactivate(user: AwarenessState['user'] | undefined): boolean {
    if (!this.active) return false;
    this.active = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!user) return false;
    return this.delegate.sendAwarenessDeparture({
      name: user.name,
      color: user.color,
      ...(user.id ? { id: user.id } : {}),
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.active) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.localState || this.destroyed || !this.active) return;
      this.localState = this.withFreshness(this.localState);
      if (this.delegate.sendAwareness) {
        void this.delegate.sendAwareness(this.localState);
      } else {
        this.delegate.setLocalAwareness(this.localState);
      }
    }, this.heartbeatIntervalMs);
  }

  private getVisibleStates(): Map<string, AwarenessState> {
    const now = this.now();
    return new Map([...this.remoteStates].filter(([, state]) => {
      const metadata = (state.user as PresenceAwareUserState).nimbalystPresence;
      return !metadata
        || metadata.version !== 1
        || now - metadata.updatedAt <= this.staleAfterMs;
    }));
  }

  private emitAwarenessAndPresence(): void {
    if (this.destroyed) return;
    const visibleStates = this.getVisibleStates();
    for (const listener of this.awarenessListeners) {
      listener(new Map(visibleStates));
    }
    const presence = this.getPresence();
    const fingerprint = participantFingerprint(presence.participants);
    if (fingerprint === this.lastPresenceFingerprint) return;
    this.lastPresenceFingerprint = fingerprint;
    for (const listener of this.presenceListeners) listener(presence);
  }
}
