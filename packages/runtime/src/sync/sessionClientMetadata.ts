import { decrypt } from './collabV3Crypto';
import type { ClientMetadata } from './collabV3WireTypes';
import type { CachedSessionIndex } from './sessionIndexMetadata';
import { encryptStable } from './stableCiphertext';
import type { SyncedSessionMetadata } from './types';

/**
 * Everything that goes into a session's encrypted client-metadata blob, from
 * each of the places that build one: the bulk publish (database row + pending
 * intent), the cache-driven index update and patch, and the session-room
 * write. The blob is replaced whole on the server, so a field any one path
 * forgets is a field the phone loses -- which is why they share this module.
 */

/**
 * Extract ClientMetadata from raw PGLite metadata.
 * This is the single place that maps database schema -> encrypted client metadata.
 */
export function buildClientMetadataFromRaw(
  metadata?: Record<string, any>,
  options: { hasBeenNamed?: boolean } = {}
): ClientMetadata | undefined {
  const tokenUsage = metadata?.tokenUsage;
  const phase = metadata?.phase as string | undefined;
  const tags = metadata?.tags as string[] | undefined;
  const draftInput = metadata?.draftInput as string | undefined;
  const draftUpdatedAt = metadata?.draftUpdatedAt as number | undefined;
  // SQLite stores the flag as 0/1. iOS decodes it strictly as Bool and skips
  // the whole session when it is a number, so normalize at the wire boundary.
  const hasBeenNamed = options.hasBeenNamed === undefined || options.hasBeenNamed === null
    ? undefined
    : !!options.hasBeenNamed;
  const hasTokenUsage = tokenUsage?.totalTokens && tokenUsage?.contextWindow;
  const hasPhaseOrTags = phase || (tags && tags.length > 0);
  // draftInput can be "" (explicit clear) - treat as meaningful
  const hasDraftField = draftInput !== undefined;
  const hasNamingMarker = hasBeenNamed !== undefined;

  if (!hasTokenUsage && !hasPhaseOrTags && !hasDraftField && !hasNamingMarker) return undefined;

  const result: ClientMetadata = {};
  if (hasTokenUsage) {
    result.currentContext = {
      tokens: tokenUsage.totalTokens,
      contextWindow: tokenUsage.contextWindow,
    };
  }
  if (phase) result.phase = phase;
  if (tags && tags.length > 0) result.tags = tags;
  if (hasDraftField) result.draftInput = draftInput;
  if (draftUpdatedAt) result.draftUpdatedAt = draftUpdatedAt;
  if (hasNamingMarker) result.hasBeenNamed = hasBeenNamed;
  return result;
}

export function buildClientMetadataFromCacheEntry(entry: Pick<
  CachedSessionIndex,
  'currentContext' | 'hasPendingPrompt' | 'phase' | 'tags' | 'draftInput' | 'draftUpdatedAt' | 'hasBeenNamed' | 'transcriptSyncDisabled'
>): ClientMetadata | undefined {
  if (
    !entry.currentContext &&
    entry.hasPendingPrompt === undefined &&
    !entry.phase &&
    !entry.tags &&
    entry.draftInput === undefined &&
    entry.hasBeenNamed === undefined &&
    !entry.transcriptSyncDisabled
  ) {
    return undefined;
  }

  return {
    currentContext: entry.currentContext,
    hasPendingPrompt: entry.hasPendingPrompt,
    phase: entry.phase,
    tags: entry.tags,
    draftInput: entry.draftInput,
    draftUpdatedAt: entry.draftUpdatedAt,
    hasBeenNamed: entry.hasBeenNamed,
    // Absent, not false, when the transcript syncs: the phone reads absence as
    // "syncs normally" and older phones never see an unknown key.
    transcriptSyncDisabled: entry.transcriptSyncDisabled || undefined,
  };
}

/**
 * The bulk publish's blob: the database row's values, with transient intent
 * (pending updates queued before the row was cached) taking precedence.
 */
export function mergeBulkClientMetadata(
  raw: ClientMetadata | undefined,
  pending: Partial<SyncedSessionMetadata> | undefined,
  hasPendingPrompt: boolean | undefined,
  transcriptSyncDisabled: boolean | undefined,
): ClientMetadata | undefined {
  const pendingMeta = pending as (Partial<SyncedSessionMetadata> & ClientMetadata) | undefined;
  if (
    !raw &&
    hasPendingPrompt === undefined &&
    pendingMeta?.currentContext === undefined &&
    pendingMeta?.phase === undefined &&
    pendingMeta?.tags === undefined &&
    pendingMeta?.draftInput === undefined &&
    pendingMeta?.draftUpdatedAt === undefined &&
    pendingMeta?.hasBeenNamed === undefined &&
    !transcriptSyncDisabled
  ) {
    return undefined;
  }
  return {
    ...raw,
    currentContext: pendingMeta?.currentContext ?? raw?.currentContext,
    hasPendingPrompt,
    phase: pendingMeta?.phase ?? raw?.phase,
    tags: pendingMeta?.tags ?? raw?.tags,
    draftInput: pendingMeta?.draftInput ?? raw?.draftInput,
    draftUpdatedAt: pendingMeta?.draftUpdatedAt ?? raw?.draftUpdatedAt,
    hasBeenNamed: pendingMeta?.hasBeenNamed ?? raw?.hasBeenNamed,
    transcriptSyncDisabled: transcriptSyncDisabled || undefined,
  };
}

/** Whether a `metadata_updated` change carries a field that lives in the client-metadata blob. */
export function changeCarriesClientMetadata(metadata: Partial<SyncedSessionMetadata>): boolean {
  return Boolean(('currentContext' in metadata && metadata.currentContext) ||
    ('hasPendingPrompt' in metadata) ||
    ('phase' in metadata) ||
    ('tags' in metadata) ||
    ('draftInput' in metadata) ||
    ('hasBeenNamed' in metadata));
}

/** The session-room blob: the change's fields over the last cached values. */
export function buildSessionRoomClientMetadata(
  change: Partial<SyncedSessionMetadata>,
  cached: CachedSessionIndex | undefined,
): ClientMetadata {
  const meta = change as Partial<SyncedSessionMetadata> & ClientMetadata;
  return {
    currentContext: ('currentContext' in meta ? meta.currentContext : cached?.currentContext) || undefined,
    hasPendingPrompt: 'hasPendingPrompt' in meta ? meta.hasPendingPrompt : cached?.hasPendingPrompt,
    phase: 'phase' in meta ? meta.phase : cached?.phase,
    tags: 'tags' in meta ? meta.tags : cached?.tags,
    draftInput: 'draftInput' in meta ? meta.draftInput : cached?.draftInput,
    draftUpdatedAt: 'draftUpdatedAt' in meta ? meta.draftUpdatedAt : cached?.draftUpdatedAt,
    hasBeenNamed: 'hasBeenNamed' in meta ? meta.hasBeenNamed : cached?.hasBeenNamed,
    transcriptSyncDisabled: cached?.transcriptSyncDisabled || undefined,
  };
}

/**
 * Keys a deferred `metadata_updated` keeps until it can be published: every
 * field `mergeSessionIndexMetadata` applies, so a change made while the
 * session was uncached or the index was down is never partially lost. Copied
 * by presence, so an explicit null (a cleared manager or parent) survives.
 */
const PENDING_METADATA_KEYS = [
  'title', 'provider', 'model', 'mode', 'workspaceId', 'sessionType', 'parentSessionId', 'worktreeId',
  'hostDeviceId', 'agentRole', 'createdBySessionId', 'isArchived', 'isPinned', 'updatedAt',
  'pendingExecution', 'isExecuting', 'queuedPrompts', 'currentContext', 'hasPendingPrompt', 'phase', 'tags',
  'lastReadAt', 'draftInput', 'draftUpdatedAt', 'hasBeenNamed',
] as const;

/**
 * Fold a change into the session's pending intent. Later values win. Returns
 * undefined when the change carries nothing worth keeping, so the caller does
 * not create an empty entry.
 */
export function mergePendingMetadataUpdate(
  existing: Partial<SyncedSessionMetadata> | undefined,
  meta: Partial<SyncedSessionMetadata>,
): Partial<SyncedSessionMetadata> | undefined {
  const source = meta as Record<string, unknown>;
  if (!PENDING_METADATA_KEYS.some(key => key in source)) return undefined;
  const next = { ...existing } as Record<string, unknown>;
  for (const key of PENDING_METADATA_KEYS) {
    if (key in source) next[key] = source[key];
  }
  return next as Partial<SyncedSessionMetadata>;
}

/**
 * The flag this device publishes for a session. The host decides from its own
 * project selection; a session another desktop hosts keeps whatever its host
 * last published, because this device's selection says nothing about it.
 * Without a predicate (phones, tests) the current value is carried through.
 */
export function resolveTranscriptSyncFlag(input: {
  isTranscriptSyncDisabled?: (projectId: string, sessionId: string) => boolean;
  projectId: string;
  sessionId: string;
  hostDeviceId?: string;
  localDeviceId?: string;
  current?: boolean;
}): boolean | undefined {
  if (!input.isTranscriptSyncDisabled) return input.current;
  if (input.hostDeviceId && input.localDeviceId && input.hostDeviceId !== input.localDeviceId) return input.current;
  return input.isTranscriptSyncDisabled(input.projectId, input.sessionId) ? true : undefined;
}

/**
 * Encrypt client metadata for wire transmission.
 */
export async function encryptClientMetadata(metadata: ClientMetadata, key: CryptoKey, sessionId: string): Promise<{ encryptedClientMetadata: string; clientMetadataIv: string }> {
  const { encrypted, iv } = await encryptStable(`clientMeta:${sessionId}`, JSON.stringify(metadata), key);
  return { encryptedClientMetadata: encrypted, clientMetadataIv: iv };
}

/**
 * Decrypt client metadata received from wire.
 */
export async function decryptClientMetadata(
  encryptedClientMetadata: string,
  clientMetadataIv: string,
  key: CryptoKey
): Promise<ClientMetadata> {
  const json = await decrypt(encryptedClientMetadata, clientMetadataIv, key);
  return JSON.parse(json);
}
