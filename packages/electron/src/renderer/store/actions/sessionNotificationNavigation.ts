import { store } from '@nimbalyst/runtime/store';
import type { SessionNotificationNavigationTarget } from '../../../shared/sessionNotificationNavigation';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  initSessionList,
  refreshSessionListAtom,
  sessionRegistryAtom,
} from '../atoms/sessions';
import {
  activeWorkspacePathAtom,
  addOpenProjectAtom,
  openProjectsAtom,
} from '../atoms/openProjects';
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
 * rail action the project switcher uses. Registering with main first is what
 * makes the `workspace:set-active` subscriber succeed for a project this window
 * has not hosted before — a bare `activeWorkspacePathAtom` write would leave
 * main scoped to the previous project.
 */
async function activateWorkspace(target: SessionNotificationNavigationTarget): Promise<boolean> {
  if (store.get(activeWorkspacePathAtom) === target.workspacePath) return true;

  const alreadyOpen = store
    .get(openProjectsAtom)
    .some((project) => project.path === target.workspacePath);

  if (!alreadyOpen) {
    try {
      const registration = await window.electronAPI.invoke(
        'workspace:register-additional',
        { workspacePath: target.workspacePath },
      );
      if (!registration?.success) {
        return showUnavailable(target, 'project-unavailable');
      }
    } catch {
      return showUnavailable(target, 'project-unavailable');
    }
  }

  store.set(addOpenProjectAtom, {
    path: target.workspacePath,
    name: target.workspacePath.split(/[\\/]/).filter(Boolean).pop() || target.workspacePath,
    openedAt: Date.now(),
  });

  // `addOpenProjectAtom` silently no-ops when the rail is at its cap; without
  // this check we would go on to select a session against the wrong workspace.
  if (store.get(activeWorkspacePathAtom) !== target.workspacePath) {
    return showUnavailable(target, 'project-unavailable');
  }
  return true;
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
  if (!hydrated || hydrated.isArchived) {
    return showUnavailable(target, hydrated?.isArchived ? 'archived' : 'missing');
  }

  store.set(setWindowModeAtom, 'agent');
  await store.set(selectSessionActionAtom, target.sessionId);
  return true;
}
