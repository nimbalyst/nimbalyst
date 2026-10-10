import type { ChatSession, UpdateSessionMetadataPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';

export interface MobileHierarchyAuthority {
  get(id: string): Promise<ChatSession | null>;
  updateMetadata(id: string, patch: UpdateSessionMetadataPayload): Promise<void>;
  publish(id: string, metadata: { parentSessionId: string | null; createdBySessionId: string | null }): Promise<void>;
}

const lanes = new WeakMap<MobileHierarchyAuthority, Map<string, Promise<unknown>>>();

/** Serialize each decision through its canonical echo; queued stale rows cannot move it. */
export function applyMobileSessionParent(authority: MobileHierarchyAuthority, sessionId: string, parentSessionId: string | null, isCurrent: () => boolean = () => true): Promise<{ accepted: boolean; error?: string }> {
  let pending = lanes.get(authority);
  if (!pending) { pending = new Map(); lanes.set(authority, pending); }
  const result = (pending.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!isCurrent()) return { accepted: false, error: 'Superseded index row' };
    const session = await authority.get(sessionId);
    if (!session) return { accepted: false, error: 'Session is not hosted on this desktop' };
    if (!isCurrent()) return { accepted: false, error: 'Superseded index row' };
    if ((session.parentSessionId ?? null) === parentSessionId) return { accepted: true };
    let error: string | undefined;
    try {
      await authority.updateMetadata(sessionId, { parentSessionId,
        hierarchySync: { source: 'remote', isCurrent },
        expectedParentSessionId: session.parentSessionId ?? null,
        expectedCreatedBySessionId: session.createdBySessionId ?? null,
      });
    } catch (failure) { error = String(failure); }
    const authoritative = await authority.get(sessionId);
    if (authoritative && isCurrent()) await authority.publish(sessionId, {
      parentSessionId: authoritative.parentSessionId ?? null,
      createdBySessionId: authoritative.createdBySessionId ?? null,
    });
    return error ? { accepted: false, error } : { accepted: true };
  });
  pending.set(sessionId, result);
  void result.finally(() => { if (pending.get(sessionId) === result) pending.delete(sessionId); }).catch(() => {});
  return result;
}
