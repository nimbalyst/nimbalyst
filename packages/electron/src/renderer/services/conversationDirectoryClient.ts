import type {
  ConversationDescriptorUpdatedEvent,
  ConversationDirectoryAgentPostingRequest,
  ConversationDirectoryArchiveRequest,
  ConversationDirectoryCreateRequest,
  ConversationDirectoryEntry,
  ConversationDirectoryListRequest,
  ConversationDirectoryMembershipRequest,
  ConversationDirectoryMembersRequest,
  ConversationDirectoryMembersResult,
  ConversationDirectoryUpdateRequest,
  ConversationMutationResult,
  CreateConversationResult,
  SetConversationMembershipResult,
} from '../../shared/conversationDirectory';

export function listConversationDirectory(
  request: ConversationDirectoryListRequest,
): Promise<ConversationDirectoryEntry[]> {
  return window.electronAPI.invoke('conversation:directory:list', request);
}

export function createDirectoryConversation(
  request: ConversationDirectoryCreateRequest,
): Promise<CreateConversationResult> {
  return window.electronAPI.invoke('conversation:directory:create', request);
}

export function updateDirectoryConversation(
  request: ConversationDirectoryUpdateRequest,
): Promise<ConversationMutationResult> {
  return window.electronAPI.invoke('conversation:directory:update', request);
}

export function archiveDirectoryConversation(
  request: ConversationDirectoryArchiveRequest,
): Promise<ConversationMutationResult> {
  return window.electronAPI.invoke('conversation:directory:archive', request);
}

export function setDirectoryConversationMembership(
  request: ConversationDirectoryMembershipRequest,
): Promise<SetConversationMembershipResult> {
  return window.electronAPI.invoke(
    'conversation:directory:set-membership',
    request,
  );
}

export function listDirectoryConversationMembers(
  request: ConversationDirectoryMembersRequest,
): Promise<ConversationDirectoryMembersResult> {
  return window.electronAPI.invoke(
    'conversation:directory:list-members',
    request,
  );
}

/**
 * Forward a team-sync `conversationDescriptorUpdated` broadcast to main so
 * every window (the organization window included, which holds no team-sync
 * socket of its own) applies the change.
 */
export function applyConversationDescriptorBroadcast(
  event: ConversationDescriptorUpdatedEvent,
): Promise<{ success: boolean }> {
  return window.electronAPI.invoke(
    'conversation:directory:apply-descriptor',
    event,
  );
}

export function setDirectoryAgentPosting(
  request: ConversationDirectoryAgentPostingRequest,
): Promise<ConversationMutationResult> {
  return window.electronAPI.invoke(
    'conversation:directory:set-agent-posting',
    request,
  );
}
