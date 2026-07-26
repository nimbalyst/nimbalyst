import { bucketItemCount, toStableAnalyticsCategory } from '../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from './teamAnalytics';

/**
 * Shared emitters for shared-folder and shared-document index mutations.
 *
 * The sidebar (human) and the MCP IPC bridge (agent) mutate the same index
 * through different code paths. Constructing the event payload in each of them
 * is how the agent path ended up reporting a hardcoded document count for
 * folder deletions -- these helpers keep the semantics identical so only
 * `actorType` and `source` differ between callers.
 */

export type CollabIndexActor = 'user' | 'agent';

export function trackFolderCreated(params: {
  actorType: CollabIndexActor;
  source: 'sidebar' | 'agent_tool';
  nested: boolean;
}): void {
  trackTeamAnalyticsEvent('collab_folder_created', params);
}

export function trackFolderRenamed(params: {
  actorType: CollabIndexActor;
  source: 'sidebar' | 'agent_tool' | 'legacy_folder';
}): void {
  trackTeamAnalyticsEvent('collab_folder_renamed', params);
}

export function trackFolderMoved(params: {
  actorType: CollabIndexActor;
  source: 'sidebar' | 'agent_tool';
  toRoot: boolean;
}): void {
  trackTeamAnalyticsEvent('collab_folder_moved', params);
}

export function trackFolderDeleted(params: {
  actorType: CollabIndexActor;
  source: 'sidebar' | 'agent_tool';
  /** Documents removed with the folder subtree, excluding the folder itself. */
  documentCount: number;
  /** Subfolders removed, excluding the folder itself. */
  subfolderCount: number;
}): void {
  trackTeamAnalyticsEvent('collab_folder_deleted', {
    actorType: params.actorType,
    source: params.source,
    documentCountBucket: bucketItemCount(params.documentCount),
    subfolderCountBucket: bucketItemCount(params.subfolderCount),
  });
}

export function trackFolderLinkCopied(params: {
  actorType: CollabIndexActor;
  entryPoint: 'sidebar' | 'context_menu' | 'agent_tool';
}): void {
  trackTeamAnalyticsEvent('collab_folder_link_copied', params);
}

export function trackDocumentAction(params: {
  action:
    | 'renamed'
    | 'moved'
    | 'trashed'
    | 'restored'
    | 'favorite_enabled'
    | 'favorite_disabled'
    | 'marked_read'
    | 'link_copied';
  actorType: CollabIndexActor;
  documentType: string | null | undefined;
  entryPoint: 'sidebar' | 'home' | 'editor' | 'context_menu' | 'agent_tool';
}): void {
  trackTeamAnalyticsEvent('collab_document_action', {
    surface: 'desktop',
    action: params.action,
    actorType: params.actorType,
    documentType: toStableAnalyticsCategory(params.documentType),
    entryPoint: params.entryPoint,
  });
}
