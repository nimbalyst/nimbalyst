/**
 * Extension ownership of AI sessions.
 *
 * A session whose `metadata.sessionOwner` is set belongs to that extension. The
 * owner is written in the same insert as the row and is inherited (without the
 * directive) by every session the owned session spawns, so ownership never
 * needs a tree walk. Only the owning extension's backend module may drive or
 * read an owned session through `ctx.services.sessions`, and only it may edit
 * `metadata.ownerMetadata`.
 *
 * Pure helpers: no database or Electron imports, so every gate that consults
 * them stays unit-testable.
 */
import type { SessionOwner } from '@nimbalyst/extension-sdk';

export const SESSION_OWNER_KEY = 'sessionOwner';
export const OWNER_METADATA_KEY = 'ownerMetadata';
export const SESSION_DIRECTIVE_KEY = 'sessionDirective';

/**
 * The owner-bag write. Ordinary metadata writes (`updateMetadata`) drop the
 * owner-controlled keys, so the owning extension's broker merges its bag with
 * this statement instead. `metadata || $1` is translated for SQLite and is the
 * same merge the tracker session-link path uses. Params: [json patch, id].
 */
export const OWNER_METADATA_MERGE_SQL =
  `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`;

function asObject(value: unknown): Record<string, unknown> | null {
  // SQLite hands whole JSON columns back as text; PGLite as objects.
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function readSessionOwner(metadata: unknown): SessionOwner | null {
  const owner = asObject(asObject(metadata)?.[SESSION_OWNER_KEY]);
  if (!owner || typeof owner.extensionId !== 'string' || !owner.extensionId) return null;
  if (typeof owner.key !== 'string') return null;
  return {
    extensionId: owner.extensionId,
    key: owner.key,
    ...(owner.routeChildUpdatesToOwner === true ? { routeChildUpdatesToOwner: true } : {}),
  };
}

export function readOwnerMetadata(metadata: unknown): Record<string, unknown> {
  return asObject(asObject(metadata)?.[OWNER_METADATA_KEY]) ?? {};
}

/**
 * The single gate every parent re-drive path consults (MetaAgentService child
 * updates, the queue driver's post-settle wake, and the direct-takeover
 * cleanup). True when the child opted out of parent updates, or when its owner
 * routes child settles to itself instead.
 */
export function isParentNotificationSuppressed(metadata: unknown): boolean {
  const md = asObject(metadata);
  if (!md) return false;
  if (md.notifyParent === false) return true;
  return readSessionOwner(md)?.routeChildUpdatesToOwner === true;
}

/**
 * Metadata a spawned child inherits from its spawner: the owner, never the
 * directive or the owner's per-session bag.
 */
export function inheritedOwnership(spawnerMetadata: unknown): Record<string, unknown> {
  const owner = readSessionOwner(spawnerMetadata);
  return owner ? { [SESSION_OWNER_KEY]: owner } : {};
}

/**
 * Drop owner-controlled keys from a metadata write. The session store applies
 * this to every `updateMetadata`, so no IPC or tool path can reassign an owner
 * or edit its bag; ownership is set once at creation, and the bag is written
 * only by the owning extension's broker (OWNER_METADATA_MERGE_SQL).
 */
export function stripOwnerControlledMetadata<T extends Record<string, unknown> | undefined>(metadata: T): T {
  if (!metadata || (!(SESSION_OWNER_KEY in metadata) && !(OWNER_METADATA_KEY in metadata))) return metadata;
  const { [SESSION_OWNER_KEY]: _owner, [OWNER_METADATA_KEY]: _bag, ...rest } = metadata as Record<string, unknown>;
  return rest as T;
}
