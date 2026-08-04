/**
 * Room ID format types.
 *
 * All room IDs are prefixed with `org:{orgId}:` for namespace isolation.
 * User-scoped rooms additionally include `user:{userId}:`; org-scoped
 * rooms are addressed by org and entity only.
 */

/** Room ID format: org:{orgId}:user:{userId}:session:{sessionId} */
export type PersonalSessionRoomId = `org:${string}:user:${string}:session:${string}`;

/** Room ID format: org:{orgId}:user:{userId}:index */
export type PersonalIndexRoomId = `org:${string}:user:${string}:index`;

/** Room ID format: org:{orgId}:user:{userId}:projects (alias of PersonalIndexRoom) */
export type ProjectsRoomId = `org:${string}:user:${string}:projects`;

/** Document room ID format: org:{orgId}:doc:{documentId} (org-scoped, not user-scoped) */
export type TeamDocumentRoomId = `org:${string}:doc:${string}`;

/** Tracker room ID format: org:{orgId}:tracker:{projectId} (org-scoped, not user-scoped) */
export type TeamTrackerRoomId = `org:${string}:tracker:${string}`;

/** Team room ID format: org:{orgId}:team (org-scoped, consolidated team state) */
export type TeamRoomId = `org:${string}:team`;

/** ProjectSync room ID format: org:{orgId}:user:{userId}:project:{projectId} (user-scoped, one per user+project) */
export type PersonalProjectSyncRoomId = `org:${string}:user:${string}:project:${string}`;

/** Conversation room ID format: org:{orgId}:conversation:{conversationId} (org-scoped, one DO per conversation) */
export type ConversationRoomId = `org:${string}:conversation:${string}`;

/** Team inbox room ID format: org:{orgId}:user:{userId}:inbox (user-scoped, one per member per org) */
export type TeamInboxRoomId = `org:${string}:user:${string}:inbox`;

export type RoomId =
  | PersonalSessionRoomId
  | PersonalIndexRoomId
  | ProjectsRoomId
  | TeamDocumentRoomId
  | TeamTrackerRoomId
  | TeamRoomId
  | PersonalProjectSyncRoomId
  | ConversationRoomId
  | TeamInboxRoomId;

/**
 * Build the conversation room id the server parses with
 * `/^org:([^:]+):conversation:([^:]+)$/`.
 */
export function conversationRoomId(
  orgId: string,
  conversationId: string
): ConversationRoomId {
  return `org:${orgId}:conversation:${conversationId}`;
}

/**
 * Build the per-member organization inbox room id the server parses with
 * `/^org:([^:]+):user:([^:]+):inbox$/`. `userId` is the org-scoped team
 * member id, never the personal user id (see jwtScopes).
 */
export function teamInboxRoomId(
  orgId: string,
  userId: string
): TeamInboxRoomId {
  return `org:${orgId}:user:${userId}:inbox`;
}
