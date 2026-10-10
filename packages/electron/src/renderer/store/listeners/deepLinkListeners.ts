import type { SharedDocumentAnchor } from '../../../shared/documentDeepLinks';
import { focusSharedDocumentAnchor } from './sharedDocumentAnchor';
import { initConsoleLinkListeners } from './consoleLinkListeners';
/**
 * Centralized IPC listeners for deep-link navigation events.
 *
 * Follows the pattern from IPC_LISTENERS.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms / dispatch
 * - Components react to the atoms
 *
 * Two delivery paths for each link kind:
 * - Live: main sends an event to an already-mounted window.
 * - Pending queue: when main creates a new window to host the link's
 *   workspace, the renderer drains the queued payload via
 *   `deep-link:consume-pending-*` on listener init and again any time the
 *   active workspace changes (covers rail-switch flows too).
 */

import { buildCollabUri } from '@nimbalyst/collab-protocol';

import { store } from '../index';
import { setWindowModeAtom } from '../atoms/windowMode';
import { requestCommentPanel } from '../../components/TabEditor/collabCommentPanelRequests';
import { pendingCollabDocumentAtom, pendingCollabFolderAtom } from '../atoms/collabDocuments';
import {
  openTrackerItemAsDocumentAtom,
  setTrackerModeLayoutAtom,
} from '../atoms/trackers';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { orgProjectWalkRefreshAtom } from '../atoms/orgProjectWalk';
import { openSettingsCommandAtom } from '../atoms/settingsNavigation';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';
import type { TrackerDeepLinkView } from '../../../shared/trackerDeepLinks';
import { requestInboxRowSelection } from '../../components/TeamMode/orgWindowCommandBus';
import {
  PROJECT_ORG_MODE_SURFACE_ID,
  inboxRoute,
  orgWindowRouteAtomFamily,
} from '../../components/TeamMode/orgWindowState';

interface SharedDocPayload extends SharedDocumentAnchor {
  documentId: string;
  orgId: string;
  workspacePath: string;
}

interface SharedFolderPayload {
  folderId: string;
  orgId: string;
  workspacePath: string;
}

interface TrackerPayload {
  trackerId: string;
  orgId: string;
  workspacePath: string;
  view?: TrackerDeepLinkView;
}

interface OrgFeedbackRequestPayload {
  requestId: string;
  orgId: string;
  workspacePath: string;
}

function ensureActiveWorkspace(workspacePath: string): void {
  const activePath = store.get(activeWorkspacePathAtom);
  if (activePath !== workspacePath) {
    // The matching workspace is warm in the project rail but not the
    // visible one. Switch to it first.
    store.set(activeWorkspacePathAtom, workspacePath);
  }
}

function applySharedDocPayload(data: SharedDocPayload): void {
  if (!data?.documentId || !data?.orgId || !data?.workspacePath) return;
  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'collab');
  focusSharedDocumentAnchor(buildCollabUri(data.orgId, data.documentId), data);
  // A comment notification wants the thread, not just the document. The request
  // is queued against the document's URI before the tab exists; the tab's
  // comments pane drains it when it mounts, selects the thread, and asks the
  // mounted anchor adapter to bring the target into view. If the anchor is gone
  // the thread still opens and the pane says why the jump did not happen.
  if (data.threadId) {
    requestCommentPanel(buildCollabUri(data.orgId, data.documentId), {
      threadId: data.threadId,
      source: 'deep-link',
    });
  }
  store.set(pendingCollabDocumentAtom, {
    scopeKey: data.workspacePath,
    orgId: data.orgId,
    documentId: data.documentId,
    analyticsSource: 'deep_link',
  });
}

function applySharedFolderPayload(data: SharedFolderPayload): void {
  if (!data?.folderId || !data?.orgId || !data?.workspacePath) return;
  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'collab');
  store.set(pendingCollabFolderAtom, {
    scopeKey: data.workspacePath,
    orgId: data.orgId,
    folderId: data.folderId,
  });
}

function applyTrackerPayload(data: TrackerPayload): void {
  if (!data?.trackerId || !data?.orgId || !data?.workspacePath) {
    throw new Error('Tracker deep-link payload requires trackerId, orgId, and workspacePath');
  }
  if (data.view !== undefined && data.view !== 'document') {
    throw new Error(`Tracker deep-link payload has unsupported view: ${data.view}`);
  }

  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'tracker');
  // 'all' so the tracker shows in the list regardless of its primaryType.
  if (data.view === 'document') {
    store.set(setTrackerModeLayoutAtom, { selectedType: 'all' });
    store.set(openTrackerItemAsDocumentAtom, data.trackerId);
  } else {
    store.set(setTrackerModeLayoutAtom, {
      selectedType: 'all',
      selectedItemId: data.trackerId,
    });
  }
}

/**
 * Bumped by every applied feedback-request payload. A drained payload was
 * queued before its round trip started, so anything applied while that round
 * trip was in flight is newer — see `drainPendingFor`.
 */
let orgFeedbackApplyGeneration = 0;

function applyOrgFeedbackRequestPayload(data: OrgFeedbackRequestPayload): void {
  if (!data?.requestId || !data?.orgId || !data?.workspacePath) return;
  orgFeedbackApplyGeneration += 1;
  ensureActiveWorkspace(data.workspacePath);
  // A feedback request is exactly what "Awaiting my reply" collects, so the
  // link lands on that row rather than on All. If the request has already been
  // answered or archived the Inbox's own row-selection latch clears the filters
  // to reveal it, so this cannot strand the recipient on an empty list.
  store.set(
    orgWindowRouteAtomFamily(PROJECT_ORG_MODE_SURFACE_ID),
    inboxRoute('awaiting'),
  );
  requestInboxRowSelection(PROJECT_ORG_MODE_SURFACE_ID, {
    orgId: data.orgId,
    sourceKind: 'feedbackRequest',
    sourceId: data.requestId,
  });
  store.set(setWindowModeAtom, 'org');
}

/**
 * Ask the project-walk listener to re-resolve. Membership just changed, so the
 * org may now have nothing bound to it on this machine.
 */
function offerProjectWalk(): void {
  store.set(orgProjectWalkRefreshAtom, (revision) => revision + 1);
}

async function trackTeamInviteOutcome(outcome: TeamInviteOutcome): Promise<void> {
  let projectMatched = false;
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (workspacePath && (outcome.status === 'accepted' || outcome.status === 'already-member')) {
    try {
      const team = await window.electronAPI.invoke('team:find-for-workspace', workspacePath) as { orgId?: string } | null;
      projectMatched = team?.orgId === outcome.orgId;
    } catch {
      // A failed enrichment must not suppress the resolved invitation event.
    }
  }
  trackTeamAnalyticsEvent('team_invitation_accepted', {
    surface: 'desktop',
    entryPoint: 'deep_link',
    projectMatched,
    status: outcome.status,
  });
}

/**
 * Team-invitation handoff from the web console. The console has already
 * accepted the invitation in the browser; main has re-derived what that means
 * for the signed-in accounts here.
 */
type TeamInviteOutcome =
  | { status: 'accepted'; orgId: string; teamName: string }
  | { status: 'already-member'; orgId: string; teamName: string }
  | { status: 'sign-in-required'; orgId: string; email?: string }
  | { status: 'not-found'; orgId: string; email?: string }
  | { status: 'error'; orgId: string; message: string };

/**
 * Open the Accounts settings panel, which renders the first-sign-in form while
 * signed out. `scope` is explicit: a scope-less link is resolved against the
 * route table, and this must not depend on that lookup to reach the right page.
 */
function openAccountSignIn(): void {
  store.set(openSettingsCommandAtom, {
    category: 'account',
    scope: 'account',
    timestamp: Date.now(),
  });
}

function applyTeamInviteOutcome(outcome: TeamInviteOutcome): void {
  if (!outcome?.status) return;
  void trackTeamInviteOutcome(outcome);

  switch (outcome.status) {
    case 'accepted':
      errorNotificationService.showInfo(
        `You joined ${outcome.teamName}`,
        'Shared documents, trackers, and projects for this team are now available.',
        { duration: 8000 }
      );
      // A toast is where this used to stop, and the user was then told they had
      // no organization. Re-resolve so the project walk can offer the org's
      // project instead.
      offerProjectWalk();
      break;
    case 'already-member':
      // Also the normal handoff path: the console accepted the invitation
      // before the app was reached, so this is a confirmation, not a no-op.
      errorNotificationService.showInfo(
        `${outcome.teamName} is ready`,
        'Shared documents, trackers, and projects for this team are available in Nimbalyst.',
        { duration: 6000 }
      );
      offerProjectWalk();
      break;
    case 'sign-in-required':
      // The common first-run path: they installed Nimbalyst because of the
      // invitation, so send them straight to the account settings that host
      // sign-in and the pending-invite list. The toast carries the same
      // destination as a button — the navigation happens behind it, so without
      // one the warning reads as a dead end.
      errorNotificationService.showWarning(
        'Sign in to accept this invitation',
        outcome.email
          ? `Sign in to Nimbalyst as ${outcome.email} to join this team.`
          : 'Sign in to Nimbalyst with the address the invitation was sent to.',
        { duration: 10000, action: { label: 'Sign in', onClick: openAccountSignIn } }
      );
      openAccountSignIn();
      break;
    case 'not-found':
      errorNotificationService.showWarning(
        'Invitation not available',
        'This invitation is no longer pending for your account. Ask the team admin to send a new one.',
        { duration: 8000 }
      );
      break;
    case 'error':
      errorNotificationService.showError(
        'Could not accept the invitation',
        outcome.message,
        { duration: 8000 }
      );
      break;
  }
}

async function drainPendingTeamInvite(): Promise<void> {
  try {
    const pending = await window.electronAPI.invoke(
      'deep-link:consume-pending-team-invite'
    ) as TeamInviteOutcome | null;
    if (pending) applyTeamInviteOutcome(pending);
  } catch (err) {
    console.error('[DeepLink] Failed to consume pending team invite:', err);
  }
}

async function drainPendingFor(workspacePath: string | null): Promise<void> {
  if (!workspacePath) return;
  const feedbackGeneration = orgFeedbackApplyGeneration;
  try {
    const [docPending, folderPending, trackerPending, feedbackPending] = await Promise.all([
      window.electronAPI.invoke('deep-link:consume-pending-shared-doc', workspacePath) as Promise<SharedDocPayload | null>,
      window.electronAPI.invoke('deep-link:consume-pending-shared-folder', workspacePath) as Promise<SharedFolderPayload | null>,
      window.electronAPI.invoke('deep-link:consume-pending-tracker', workspacePath) as Promise<TrackerPayload | null>,
      window.electronAPI.invoke('deep-link:consume-pending-org-feedback-request', workspacePath) as Promise<OrgFeedbackRequestPayload | null>,
    ]);
    if (docPending) applySharedDocPayload(docPending);
    if (folderPending) applySharedFolderPayload(folderPending);
    if (trackerPending) applyTrackerPayload(trackerPending);
    // A live event that landed while this drain was in flight carries the newer
    // request; letting the drained one through would move the Inbox selection
    // back to the older link the user has already been taken past.
    if (feedbackPending && orgFeedbackApplyGeneration === feedbackGeneration) {
      applyOrgFeedbackRequestPayload(feedbackPending);
    }
  } catch (err) {
    console.error('[DeepLink] Failed to consume pending payload:', err);
  }
}

/**
 * Initialize deep-link IPC listeners. Should be called once at startup.
 */
export function initDeepLinkListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Console links (`https://console.nimbalyst.com/...`) main routes here
  // instead of the browser, clicked or arriving as `nimbalyst://console/...`.
  cleanups.push(initConsoleLinkListeners());

  // Live: shared document link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-shared-document', (data: SharedDocPayload) => {
      applySharedDocPayload(data);
    })
  );

  // Live: shared folder link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-shared-folder', (data: SharedFolderPayload) => {
      applySharedFolderPayload(data);
    })
  );

  // Live: no known workspace matches the folder link's orgId, or not signed in.
  cleanups.push(
    window.electronAPI.on('deep-link:shared-folder-not-available', (data: {
      folderId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this shared folder.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this folder.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for shared folder:', data);
    })
  );

  // Live: tracker link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-tracker', (data: TrackerPayload) => {
      applyTrackerPayload(data);
    })
  );

  // Live: a feedback request owned by this project's organization opens the
  // mode's Inbox and selects the delivery for that request.
  cleanups.push(
    window.electronAPI.on('deep-link:open-org-feedback-request', (data: OrgFeedbackRequestPayload) => {
      applyOrgFeedbackRequestPayload(data);
      // The live event and mount-time queue protect opposite sides of the
      // listener race. Consuming after a live apply prevents a later workspace
      // switch from replaying the same selection.
      void window.electronAPI.invoke(
        'deep-link:consume-pending-org-feedback-request',
        data.workspacePath,
      ).catch((err) => {
        console.error('[DeepLink] Failed to clear pending org feedback request:', err);
      });
    })
  );

  // Live: no known workspace matches the link's orgId, or the user isn't signed in.
  cleanups.push(
    window.electronAPI.on('deep-link:shared-document-not-available', (data: {
      documentId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this shared document.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this document.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for shared doc:', data);
    })
  );

  cleanups.push(
    window.electronAPI.on('deep-link:tracker-not-available', (data: {
      trackerId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this tracker.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this tracker.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for tracker:', data);
    })
  );

  // Live: team-invitation handoff from the web console. The event is a bare
  // nudge — the outcome is always read through the consuming IPC below, so a
  // nudge racing the mount-time drain still applies the invitation once.
  cleanups.push(
    window.electronAPI.on('deep-link:team-invite-available', () => {
      void drainPendingTeamInvite();
    })
  );

  // Drain any pending payload queued before this listener mounted (newly
  // created window case).
  void drainPendingFor(store.get(activeWorkspacePathAtom));

  // The invite handoff is not workspace-keyed — a cold launch straight from the
  // email has no active workspace to drain against.
  void drainPendingTeamInvite();

  // Also drain when the active workspace changes — covers users switching
  // projects in the rail to one that has a queued link.
  const unsubscribe = store.sub(activeWorkspacePathAtom, () => {
    void drainPendingFor(store.get(activeWorkspacePathAtom));
  });
  cleanups.push(unsubscribe);

  return () => {
    cleanups.forEach((fn) => fn?.());
  };
}
