// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { openSettingsCommandAtom } from '../../atoms/settingsNavigation';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { pendingCollabDocumentAtom } from '../../atoms/collabDocuments';
import {
  trackerModeDocumentItemIdAtom,
  trackerModeLayoutAtom,
} from '../../atoms/trackers';
import { resetWindowMode, windowModeAtom } from '../../atoms/windowMode';
import { activeExtensionPanelAtom, extensionPanelStateAtomFamily } from '../../atoms/extensionPanels';
import { initDeepLinkListeners } from '../deepLinkListeners';
import {
  resetCommentPanelRequests,
  subscribeCommentPanelRequests,
} from '../../../components/TabEditor/collabCommentPanelRequests';
import { normalizeSettingsDestination } from '../../../components/Settings/settingsRoutes';
import {
  consumeInboxRowSelectionRequest,
} from '../../../components/TeamMode/orgWindowCommandBus';
import {
  conversationRoute,
  PROJECT_ORG_MODE_SURFACE_ID,
  orgWindowRouteAtomFamily,
} from '../../../components/TeamMode/orgWindowState';

/** What App.tsx actually navigates to for the currently-queued settings command. */
function resolvedSettingsDestination() {
  const command = store.get(openSettingsCommandAtom);
  if (!command) return null;
  return normalizeSettingsDestination({ category: command.category, scope: command.scope });
}

describe('tracker deep-link routing', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  let pendingTrackerPayload: Record<string, unknown> | null;

  beforeEach(() => {
    handlers = {};
    pendingTrackerPayload = null;
    store.set(activeWorkspacePathAtom, '/workspace/source');
    store.set(windowModeAtom, 'files');
    store.set(extensionPanelStateAtomFamily('/workspace/target'), {
      panelId: 'com.nimbalyst.project-graph.graph', bottomPanelId: null, revision: 1, hydrated: true,
    });
    store.set(pendingCollabDocumentAtom, null);
    store.set(
      orgWindowRouteAtomFamily(PROJECT_ORG_MODE_SURFACE_ID),
      conversationRoute('conversation-before-link'),
    );
    consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID);
    store.set(trackerModeLayoutAtom, {
      ...store.get(trackerModeLayoutAtom),
      selectedType: 'plan',
      selectedItemId: null,
      itemViews: {},
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-pending-tracker') {
            return pendingTrackerPayload;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: {
          record: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    resetWindowMode();
    store.set(activeWorkspacePathAtom, null);
    store.set(windowModeAtom, 'files');
    store.set(pendingCollabDocumentAtom, null);
    consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID);
    resetCommentPanelRequests();
  });

  it('binds a shared-document link to the workspace scope selected by the desktop host', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-shared-document']({
      documentId: 'doc-target',
      orgId: 'org-target',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    expect(store.get(pendingCollabDocumentAtom)).toMatchObject({
      documentId: 'doc-target',
      scopeKey: '/workspace/target',
      orgId: 'org-target',
      analyticsSource: 'deep_link',
    });
  });

  it('carries a comment notification thread target to the document comments pane', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-shared-document']({
      documentId: 'doc-target',
      orgId: 'org-target',
      workspacePath: '/workspace/target',
      threadId: 'thread-7',
    });

    // The pane does not exist yet -- the document is still opening -- so the
    // request has to be waiting for it under the document's own URI. Thread
    // identity only: nothing about where the anchor is travels with the link.
    const delivered: unknown[] = [];
    const unsubscribe = subscribeCommentPanelRequests(
      'collab://org:org-target:doc:doc-target',
      (request) => delivered.push(request),
    );
    unsubscribe();

    expect(delivered).toEqual([{ threadId: 'thread-7', source: 'deep-link' }]);
  });

  it('keeps links without view on the plain tracker selection path', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-tracker']({
      trackerId: 'tracker-plain',
      orgId: 'org-1',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-plain',
      itemViews: {},
    });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();
  });

  it('drains a pending view=document link into document presentation', async () => {
    pendingTrackerPayload = {
      trackerId: 'tracker-document',
      orgId: 'org-1',
      workspacePath: '/workspace/source',
      view: 'document',
    };

    cleanup = initDeepLinkListeners();

    await vi.waitFor(() => {
      expect(store.get(trackerModeDocumentItemIdAtom)).toBe('tracker-document');
    });
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-document',
      itemViews: { 'tracker-document': 'document' },
    });
  });

  it('opens a project-org feedback request in Org mode with its Inbox row latched', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-org-feedback-request']({
      requestId: 'request-target',
      orgId: 'org-project',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('org');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    // "Awaiting my reply" is the row a feedback request belongs to, and the
    // reason axis is navigation now — landing on All would show the recipient
    // every delivery except, potentially, the one they clicked a link for.
    expect(store.get(orgWindowRouteAtomFamily(PROJECT_ORG_MODE_SURFACE_ID)))
      .toEqual({ view: 'inbox', filter: 'awaiting' });
    expect(consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID)).toEqual({
      orgId: 'org-project',
      sourceKind: 'feedbackRequest',
      sourceId: 'request-target',
    });
  });
});

describe('team-invitation deep-link handoff', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  /** Stands in for main's consume-and-clear: reading it hands over ownership. */
  let pendingInvite: Record<string, unknown> | null;
  let consumeCount: number;

  beforeEach(() => {
    handlers = {};
    pendingInvite = null;
    consumeCount = 0;
    store.set(openSettingsCommandAtom, null);
    vi.spyOn(errorNotificationService, 'showInfo').mockReturnValue('');
    vi.spyOn(errorNotificationService, 'showWarning').mockReturnValue('');

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-pending-team-invite') {
            consumeCount += 1;
            const pending = pendingInvite;
            pendingInvite = null;
            return pending;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: { record: vi.fn(async () => undefined) },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    store.set(openSettingsCommandAtom, null);
  });

  it('applies an invitation once even when the nudge races the mount-time drain', async () => {
    pendingInvite = { status: 'accepted', orgId: 'org-acme', teamName: 'Acme' };

    cleanup = initDeepLinkListeners();
    // Main fires the nudge at a window that is already draining. The outcome
    // must be read through the consuming IPC, never carried on the event, or
    // the invitee sees the same toast twice.
    handlers['deep-link:team-invite-available']?.(undefined);

    await vi.waitFor(() => expect(consumeCount).toBeGreaterThanOrEqual(2));
    expect(errorNotificationService.showInfo).toHaveBeenCalledTimes(1);
    expect(errorNotificationService.showInfo).toHaveBeenCalledWith(
      'You joined Acme',
      expect.any(String),
      expect.anything(),
    );
  });

  it('sends an invitee with no matching account to the account sign-in panel', async () => {
    pendingInvite = {
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    };

    cleanup = initDeepLinkListeners();

    // Asserted through the resolver App.tsx feeds the command into, not on the
    // raw command: a scope-less `{ category: 'account' }` normalizes all the way
    // down to Application -> Notifications, which is where invitees were landing
    // with nothing on screen to sign in with.
    await vi.waitFor(() => {
      expect(resolvedSettingsDestination()).toEqual({ scope: 'account', category: 'account' });
    });
    expect(errorNotificationService.showWarning).toHaveBeenCalledWith(
      'Sign in to accept this invitation',
      expect.stringContaining('invitee@test.com'),
      expect.anything(),
    );

    // The toast outlives the navigation behind it, so its button has to be able
    // to re-issue the same destination.
    const options = vi.mocked(errorNotificationService.showWarning).mock.calls.at(-1)?.[2];
    expect(options?.action?.label).toBe('Sign in');
    store.set(openSettingsCommandAtom, null);
    options?.action?.onClick();
    expect(resolvedSettingsDestination()).toEqual({ scope: 'account', category: 'account' });
  });
});
