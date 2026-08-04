import type {
  CollaborationAction,
  ConversationDescriptor,
  ConversationMembership,
  ConversationMembersResponse,
  ConversationSubscription,
} from '@nimbalyst/collab-protocol';

/**
 * A directory row: the descriptor plus this caller's resolved capabilities.
 *
 * The descriptor's optional `subscription` is the caller's own — omitted by
 * older servers, which is why the notification bell only hydrates from a value
 * that is actually present.
 */
export type ConversationDirectoryEntry = ConversationDescriptor & {
  capabilities: CollaborationAction[];
};

export interface ListConversationsOptions {
  includeDirect?: boolean;
  includeArchived?: boolean;
}

export interface CreateConversationInput {
  id?: string;
  kind: ConversationDescriptor['kind'];
  visibility: ConversationDescriptor['visibility'];
  documentId?: string;
  title?: string;
  topic?: ConversationDescriptor['topic'];
  memberships?: Array<{
    userId: string;
    role?: ConversationMembership['role'];
  }>;
  agentPostingEnabled?: boolean;
}

/**
 * Title/topic edits for an organization room.
 *
 * Both fields are optional and only the ones present are sent: the server
 * distinguishes "absent" (leave alone) from "present" (replace), so an
 * unspecified topic must not be serialized at all. `topic: null` clears it.
 */
export interface UpdateConversationInput {
  title?: string;
  topic?: string | null;
}

export interface ConversationMutationResult {
  descriptor: ConversationDescriptor;
}

export interface CreateConversationResult extends ConversationMutationResult {
  memberships: ConversationMembership[];
}

export interface SetConversationMembershipInput {
  active: boolean;
  role?: ConversationMembership['role'];
}

export interface SetConversationMembershipResult {
  memberships: ConversationMembership[];
}

export interface ConversationDirectoryListRequest
  extends ListConversationsOptions {
  orgId: string;
}

export interface ConversationDirectoryCreateRequest {
  orgId: string;
  input: CreateConversationInput;
}

export interface ConversationDirectoryUpdateRequest {
  orgId: string;
  conversationId: string;
  input: UpdateConversationInput;
}

export interface ConversationDirectoryArchiveRequest {
  orgId: string;
  conversationId: string;
}

export interface ConversationDirectoryMembershipRequest
  extends SetConversationMembershipInput {
  orgId: string;
  conversationId: string;
  userId: string;
}

export interface ConversationDirectoryMembersRequest {
  orgId: string;
  conversationId: string;
}

export type ConversationDirectoryMembersResult = ConversationMembersResponse;

export interface ConversationDirectoryAgentPostingRequest {
  orgId: string;
  conversationId: string;
  enabled: boolean;
}

export interface ConversationSetSubscriptionRequest {
  orgId: string;
  conversationId: string;
  state: ConversationSubscription['state'];
  notificationLevel: ConversationSubscription['notificationLevel'];
}

export interface ConversationDirectoryChangedEvent {
  orgId: string;
}

/**
 * A team-sync `conversationDescriptorUpdated` broadcast, forwarded through main
 * so every window sees it — the organization window holds no team-sync socket
 * of its own. Same shape of pipeline as `org:settings:apply`.
 */
export interface ConversationDescriptorUpdatedEvent {
  orgId: string;
  descriptor: ConversationDescriptor;
}
