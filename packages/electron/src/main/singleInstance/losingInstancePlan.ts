import type { LaunchTarget } from '../shellCommand/launchTarget';

/** How long a macOS second instance waits for an `open-file` or `open-url` Apple Event. */
const APPLE_EVENT_WAIT_MS = 5000;

export type LosingInstancePlan =
    // The primary watches userData for the signal file this writes.
    | { action: 'relay-file-and-quit'; filePath: string }
    // The primary gets folders, missing paths and deep links from its
    // `second-instance` event, which carries this process's argv and cwd.
    | { action: 'quit'; reason: 'directory' | 'missing' | 'deep-link' | 'no-target' }
    // macOS delivers a launch's file or deep link as an Apple Event, not argv.
    | { action: 'wait-for-apple-event'; timeoutMs: number };

/**
 * What a process that lost `requestSingleInstanceLock()` does before it quits.
 *
 * Only macOS delivers a launch's file or deep link through an event
 * (`open-file`, `open-url`), which arrives after the event loop starts, so
 * only there is waiting worth it.
 * Elsewhere a launch with nothing in argv has nothing to hand over (#1188,
 * #1070): waiting just kept the process alive long enough to boot the app.
 */
export function planLosingInstance(input: {
    platform: NodeJS.Platform;
    launchTarget: LaunchTarget | null;
    hasDeepLink: boolean;
}): LosingInstancePlan {
    const { launchTarget } = input;
    if (launchTarget && launchTarget.kind !== 'file') return { action: 'quit', reason: launchTarget.kind };
    if (launchTarget) return { action: 'relay-file-and-quit', filePath: launchTarget.path };
    if (input.hasDeepLink) return { action: 'quit', reason: 'deep-link' };
    if (input.platform === 'darwin') return { action: 'wait-for-apple-event', timeoutMs: APPLE_EVENT_WAIT_MS };
    return { action: 'quit', reason: 'no-target' };
}
