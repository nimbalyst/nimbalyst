export type AppAction =
  | { type: 'open-project-manager' }
  | { type: 'keyboard-shortcuts' }
  | { type: 'new-project' }
  | { type: 'walkthrough'; walkthroughId: string };

export interface AppActionHandlers {
  openProjectManager(): void;
  openKeyboardShortcuts(): void;
  recognizedNoop(action: Extract<AppAction, { type: 'new-project' | 'walkthrough' }>): void;
  unknownAction(url: string): void;
}

const WALKTHROUGH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseAppActionLink(url: string): AppAction | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'nimbalyst:' ||
    parsed.host !== 'action' ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const segments = parsed.pathname.split('/').slice(1);
  if (segments.length === 1) {
    switch (segments[0]) {
      case 'open-project-manager':
        return { type: 'open-project-manager' };
      case 'keyboard-shortcuts':
        return { type: 'keyboard-shortcuts' };
      case 'new-project':
        return { type: 'new-project' };
      default:
        return null;
    }
  }

  if (segments.length === 2 && segments[0] === 'walkthrough') {
    let walkthroughId: string;
    try {
      walkthroughId = decodeURIComponent(segments[1]);
    } catch {
      return null;
    }
    if (WALKTHROUGH_ID_RE.test(walkthroughId)) {
      return { type: 'walkthrough', walkthroughId };
    }
  }

  return null;
}

export function dispatchAppActionLink(
  url: string,
  handlers: AppActionHandlers,
): AppAction | null {
  const action = parseAppActionLink(url);
  if (!action) {
    handlers.unknownAction(url);
    return null;
  }

  switch (action.type) {
    case 'open-project-manager':
      handlers.openProjectManager();
      break;
    case 'keyboard-shortcuts':
      handlers.openKeyboardShortcuts();
      break;
    case 'new-project':
    case 'walkthrough':
      handlers.recognizedNoop(action);
      break;
  }

  return action;
}
