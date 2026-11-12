import { store } from '@nimbalyst/runtime/store';
import type { SessionNotificationNavigationTarget } from '../../../shared/sessionNotificationNavigation';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  initSessionList,
  refreshSessionListAtom,
  sessionRegistryAtom,
} from '../atoms/sessions';
import { activateRailProject } from './activateRailProject';
import { activeWorkspacePathAtom, multiProjectModeAtom } from '../atoms/openProjects';
import {
  initWorkstreamState,
  loadWorkstreamStates,
  workstreamStatesLoadedAtom,
} from '../atoms/workstreamState';
import { setWindowModeAtom } from '../atoms/windowMode';
import { selectSessionActionAtom } from './sessionHistoryActions';

interface SessionLookup {
  id: string;
  isArchived?: boolean;
}

interface SessionListResult {
  success?: boolean;
  sessions?: SessionLookup[];
  error?: string;
}

type NavigationFailure = 'archived' | 'missing' | 'lookup-failed' | 'project-unavailable';

const MAX_SOURCE_LABEL_LENGTH = 60;

function safeSourceLabel(target: SessionNotificationNavigationTarget): string {
  const sanitized = Array.from(target.sourceLabel || '')
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SOURCE_LABEL_LENGTH);
  return sanitized || `Session ${target.sessionId.slice(0, 8)}`;
}

function failureMessage(
  target: SessionNotificationNavigationTarget,
  reason: NavigationFailure,
): string {
  const shortId = target.sessionId.slice(0, 8);
  switch (reason) {
    case 'archived':
      return `Session ${shortId} is archived and was not opened. Restore it from archived sessions, then retry.`;
    case 'missing':
      return `Session ${shortId} could not be found in its originating project.`;
    case 'project-unavailable':
      return `Nimbalyst could not switch to the project for session ${shortId}. Close a project from the rail, then retry.`;
    default:
      return `Nimbalyst could not verify session ${shortId} in its originating project.`;
  }
}

function showUnavailable(
  target: SessionNotificationNavigationTarget,
  reason: NavigationFailure,
): false {
  const label = safeSourceLabel(target);
  let notificationId = '';
  notificationId = errorNotificationService.showWarning(
    `${label} unavailable`,
    failureMessage(target, reason),
    {
      duration: 0,
      // A retry that fails the same way must still produce visible feedback,
      // so it replaces the existing warning instead of being deduplicated away.
      allowDuplicate: true,
      action: {
        label: 'Retry',
        onClick: () => {
          errorNotificationService.dismiss(notificationId);
          void navigateToNotificationSession(target);
        },
      },
    },
  );
  return false;
}

async function lookupTarget(
  target: SessionNotificationNavigationTarget,
): Promise<SessionLookup | null> {
  let result: SessionListResult;
  try {
    result = await window.electronAPI.invoke(
      'sessions:list',
      target.workspacePath,
      { includeArchived: true },
    ) as SessionListResult;
  } catch {
    showUnavailable(target, 'lookup-failed');
    return null;
  }

  if (!result?.success || !Array.isArray(result.sessions)) {
    showUnavailable(target, 'lookup-failed');
    return null;
  }

  const session = result.sessions.find((candidate) => candidate.id === target.sessionId);
  if (!session) {
    showUnavailable(target, 'missing');
    return null;
  }
  if (session.isArchived) {
    showUnavailable(target, 'archived');
    return null;
  }
  return session;
}

/**
 * Make the notification's workspace the active one, going through the same
 * rail action the project switcher uses. A bare `activeWorkspacePathAtom`
 * write would leave main scoped to the previous project.
 */
async function activateWorkspace(target: SessionNotificationNavigationTarget): Promise<boolean> {
  if (await activateRailProject(target.workspacePath)) return true;
  // Without this we would go on to select a session against the wrong workspace.
  return showUnavailable(target, 'project-unavailable');
}

/**
 * Resolve the target in this window's session registry, refreshing once when
 * the registry is behind the database. The pre-flight `sessions:list` already
 * proved the session exists, so a registry miss here means stale renderer
 * state, not a missing session — reporting "could not be found" would be wrong.
 */
async function hydrateTarget(
  target: SessionNotificationNavigationTarget,
): Promise<SessionLookup | null> {
  const fromRegistry = () => store.get(sessionRegistryAtom).get(target.sessionId);

  let hydrated = fromRegistry();
  if (!hydrated) {
    await store.set(refreshSessionListAtom);
    hydrated = fromRegistry();
  }
  return hydrated ?? null;
}

/**
 * Navigate from a native notification without consulting ambient workspace
 * state. The immutable workspace/session pair is validated before any visible
 * selection changes, so a stale notification can never route to another
 * session as a fallback.
 */
export async function navigateToNotificationSession(
  target: SessionNotificationNavigationTarget,
): Promise<boolean> {
  if (!target?.sessionId || !target?.workspacePath) {
    console.error(
      '[sessionNotificationNavigation] Ignoring navigation without sessionId and workspacePath',
      target,
    );
    return false;
  }

  const session = await lookupTarget(target);
  if (!session) return false;

  if (!await activateWorkspace(target)) return false;

  // Prime the workspace-scoped state before selecting. AgentMode performs the
  // same initialization when the project view mounts; these calls make the
  // notification path deterministic even when navigation arrives first.
  initWorkstreamState(target.workspacePath);
  const needsWorkstreamLoad = !store.get(workstreamStatesLoadedAtom);
  await Promise.all([
    initSessionList(target.workspacePath),
    // Only load on a cold window. `loadWorkstreamStates` replaces the whole
    // in-memory map from the debounced persisted snapshot, which would clobber
    // hierarchy state (activeChildId / childSessionIds) that
    // loadSessionChildrenAtom and setWorkstreamActiveChildAtom own.
    needsWorkstreamLoad ? loadWorkstreamStates(target.workspacePath) : Promise.resolve(),
  ]);

  const hydrated = await hydrateTarget(target);
  // The user can switch projects while the loads above are in flight.
  // `selectSessionActionAtom` selects under the active project, so selecting
  // now would put this session into whichever project they moved to.
  if (store.get(activeWorkspacePathAtom) !== target.workspacePath) {
    console.warn('[sessionNotificationNavigation] Project changed during navigation; not selecting', target.sessionId);
    return false;
  }
  if (!hydrated || hydrated.isArchived) {
    // A registry miss after the pre-flight lookup succeeded is stale renderer
    // state, not a missing session -- see hydrateTarget.
    return showUnavailable(target, hydrated?.isArchived ? 'archived' : 'lookup-failed');
  }

  store.set(setWindowModeAtom, 'agent');
  await store.set(selectSessionActionAtom, target.sessionId);
  return true;
}

/**
 * Open a session that belongs to `target.workspacePath` from a window that may
 * be showing another project. With the project rail on, this window switches
 * to the project and selects it. With the rail off this window shows only its
 * own project, so main focuses or opens that project's window and that window
 * selects the session -- the same routing a notification click uses.
 */
export async function openSessionInOwningProject(
  target: SessionNotificationNavigationTarget,
): Promise<boolean> {
  if (store.get(multiProjectModeAtom) || store.get(activeWorkspacePathAtom) === target.workspacePath) {
    return navigateToNotificationSession(target);
  }
  try {
    await window.electronAPI.invoke('notifications:navigate-to-session', target);
    return true;
  } catch (error) {
    console.error('[sessionNotificationNavigation] Failed to hand the session to its project window:', error);
    return showUnavailable(target, 'project-unavailable');
  }
}
