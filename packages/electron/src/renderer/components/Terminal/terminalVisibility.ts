/**
 * Container-measurability helpers for TerminalPanel init (NIM-826).
 *
 * A terminal can legitimately (re)mount while its container has zero size:
 * the Claude CLI raw-terminal drawer body is `display:none` while collapsed
 * (and NIM-820 made a user collapse sticky across remounts), and a session
 * switch remounts the panel in whatever layout state was persisted. The old
 * init path threw "Terminal container never became measurable" after 1.5s,
 * which left the strip in a dead error state even though the PTY in the main
 * process was still alive — the user read this as the CLI session
 * "disconnecting" whenever they switched sessions.
 *
 * The replacement contract:
 *   - `isElementMeasurable` is the synchronous fast-path check.
 *   - `waitUntilElementMeasurable` polls WITHOUT a deadline until the element
 *     gains real dimensions (drawer expanded / layout shown) or the caller
 *     disposes. It never rejects — hidden is a valid state to wait through,
 *     not an error.
 *
 * Deps are injected so the loop is unit-testable without real timers.
 */

export interface MeasurableElement {
  getBoundingClientRect(): { width: number; height: number };
}

/** Default gap between rect polls. Cheap enough to leave running while hidden. */
export const MEASURABLE_POLL_MS = 250;

export function isElementMeasurable(element: MeasurableElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export interface WaitUntilMeasurableOptions {
  /** Polled before each check; `true` ends the wait (component unmounted / re-init). */
  isDisposed: () => boolean;
  pollMs?: number;
  /** Injectable for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve `'measurable'` once the element has non-zero dimensions, or
 * `'disposed'` if the caller tears down first. Never rejects, never times out.
 */
export async function waitUntilElementMeasurable(
  element: MeasurableElement,
  options: WaitUntilMeasurableOptions,
): Promise<'measurable' | 'disposed'> {
  const { isDisposed, pollMs = MEASURABLE_POLL_MS, sleep = defaultSleep } = options;

  for (;;) {
    if (isDisposed()) return 'disposed';
    if (isElementMeasurable(element)) return 'measurable';
    await sleep(pollMs);
  }
}
