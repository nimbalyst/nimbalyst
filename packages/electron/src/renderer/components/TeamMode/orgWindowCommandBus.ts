import {
  ORG_WINDOW_COMMANDS,
  isOrgWindowCommand,
  type OrgWindowCommand,
} from '../../../shared/orgWindowCommands';

/**
 * The org window's messaging command bus.
 *
 * `TeamManagementApp` is the only publisher — it turns the native Messages menu
 * (over IPC) and the window's own key handling into one command stream. The
 * consumers sit deep in the tree (`TeamMode`'s body owns routing and the
 * compose dialog; the Inbox owns its search field), and a window `CustomEvent`
 * keeps them decoupled from it: nothing has to be threaded through props, and
 * the sibling components stay editable without touching this wiring.
 *
 * The same imperative-event shape as `nimbalyst:workstream-open-tracker`.
 */
export const ORG_WINDOW_COMMAND_EVENT = 'nimbalyst:org-window-command';

export { ORG_WINDOW_COMMANDS, isOrgWindowCommand };
export type { OrgWindowCommand };

export function dispatchOrgWindowCommand(command: OrgWindowCommand): void {
  window.dispatchEvent(
    new CustomEvent(ORG_WINDOW_COMMAND_EVENT, { detail: command }),
  );
}

/**
 * Subscribe to one command. Returns the unsubscribe closure, matching the
 * shape `window.electronAPI.on` returns.
 */
export function subscribeOrgWindowCommand(
  command: OrgWindowCommand,
  handler: () => void,
): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<OrgWindowCommand>).detail !== command) return;
    handler();
  };
  window.addEventListener(ORG_WINDOW_COMMAND_EVENT, listener);
  return () => window.removeEventListener(ORG_WINDOW_COMMAND_EVENT, listener);
}

/**
 * A pending "put the cursor in the Inbox search field" request.
 *
 * Search Messages routes the window to the Inbox first, so the field it wants
 * to focus usually does not exist yet when the command fires. The request is
 * therefore latched: a mounted field consumes it immediately, and one that
 * mounts a tick later picks it up on its way in.
 */
let inboxSearchFocusPending = false;
const inboxSearchFocusListeners = new Set<() => void>();

export function requestInboxSearchFocus(): void {
  inboxSearchFocusPending = true;
  for (const listener of inboxSearchFocusListeners) listener();
}

/** True at most once per request; the caller is expected to focus the field. */
export function consumeInboxSearchFocusRequest(): boolean {
  const pending = inboxSearchFocusPending;
  inboxSearchFocusPending = false;
  return pending;
}

export function subscribeInboxSearchFocus(listener: () => void): () => void {
  inboxSearchFocusListeners.add(listener);
  return () => { inboxSearchFocusListeners.delete(listener); };
}
