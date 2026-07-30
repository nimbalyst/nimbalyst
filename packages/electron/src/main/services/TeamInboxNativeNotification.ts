import { app, Notification } from 'electron';

import { createTeamManagementWindow, isTeamManagementWindowFocusedOn } from '../window/TeamManagementWindow';
import { logger } from '../utils/logger';
import { isOSNotificationsEnabled } from '../utils/store';
import { listConversations, listMembers } from './TeamService';
import {
  TeamInboxNotificationService,
  type TeamInboxNativeNotification,
} from './TeamInboxNotificationService';

const DIRECTORY_CACHE_MS = 60_000;

interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  const promise = load();
  cache.set(key, { expiresAt: now + DIRECTORY_CACHE_MS, promise });
  void promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

function showNativeNotification(
  options: TeamInboxNativeNotification,
): void {
  const notification = new Notification({
    title: options.title,
    body: options.body,
    icon: process.platform === 'darwin' || process.platform === 'win32'
      ? app.getPath('exe')
      : '',
    urgency: 'normal',
    timeoutType: 'default',
  });
  notification.on('click', options.onClick);
  notification.on('failed', (_event, error) => {
    logger.main.warn('[TeamInboxNotification] Native notification failed:', error);
  });
  notification.show();
}

export function createTeamInboxNotificationService(
  openInboxSource: (url: string) => Promise<boolean>,
): TeamInboxNotificationService {
  const conversationCache = new Map<string, CacheEntry<
    Awaited<ReturnType<typeof listConversations>>
  >>();
  const memberCache = new Map<string, CacheEntry<
    Awaited<ReturnType<typeof listMembers>>
  >>();

  return new TeamInboxNotificationService({
    notificationsEnabled: isOSNotificationsEnabled,
    notificationsSupported: () => Notification.isSupported(),
    isConversationFocused: isTeamManagementWindowFocusedOn,
    showNativeNotification,
    openConversation: (orgId, conversationId) => {
      createTeamManagementWindow({ orgId, conversationId });
    },
    openInboxSource,
    resolveConversationTitle: async (orgId, conversationId) => {
      const conversations = await cached(
        conversationCache,
        orgId,
        () => listConversations(orgId),
      );
      const conversation = conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      return conversation?.title?.trim()
        || (conversation?.kind === 'dm' ? 'Direct message' : null);
    },
    resolveMemberLabel: async (orgId, memberId) => {
      const roster = await cached(
        memberCache,
        orgId,
        () => listMembers(orgId),
      );
      const member = roster.members.find(
        (candidate) => candidate.memberId === memberId,
      );
      return member?.name?.trim() || member?.email?.trim() || null;
    },
  });
}
