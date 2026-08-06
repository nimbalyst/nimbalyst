export const APP_ACTION_DISPATCH_CHANNEL = 'app-action:dispatch';

interface ElectronActionBridge {
  send?: (channel: string, href: string) => void;
}

function getElectronActionBridge(): ElectronActionBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (window as unknown as { electronAPI?: ElectronActionBridge }).electronAPI;
}

export function isAppActionHref(href?: string | null): href is string {
  if (!href) {
    return false;
  }

  try {
    const parsed = new URL(href.trim());
    return parsed.protocol === 'nimbalyst:' && parsed.host === 'action';
  } catch {
    return false;
  }
}

/**
 * Dispatch an app-action href to the Electron main process.
 *
 * Returning true means the href belongs to the reserved app-action namespace
 * and must not fall through to browser or external-link navigation. The main
 * process owns the strict action allowlist.
 */
export function dispatchAppActionHref(href?: string | null): boolean {
  if (!isAppActionHref(href)) {
    return false;
  }

  getElectronActionBridge()?.send?.(APP_ACTION_DISPATCH_CHANNEL, href.trim());
  return true;
}
