/**
 * The host capability contract.
 *
 * `packages/runtime` is cross-platform by design, but two modules reached
 * directly for Electron's `app` object to answer two questions: "am I running
 * from a packaged build?" and "where is the application root?". That made the
 * Claude Code launch path unusable from any host without an Electron process.
 *
 * Those two questions are the entire Electron surface in runtime — eight call
 * sites, two primitives. This module states them as an interface so each host
 * answers them for itself: Electron from `app`, a headless Node process from
 * its own layout.
 *
 * Both are methods rather than fields on purpose. `app.isPackaged` and
 * `app.getAppPath()` must be read lazily at call time, never captured at module
 * load, because a singleton that reads them during import runs before the
 * Electron app is ready.
 */

export interface HostEnvironment {
  /** Headless hosts accept only provisioned agent configuration, never repository hooks or ambient MCP discovery. */
  agentConfiguration?: 'explicit-only';
  /**
   * True when running from a packaged application bundle whose resources live
   * inside an asar archive. A headless host answers false: there is no asar,
   * and the packaged-path construction that flag guards would resolve nowhere.
   */
  isPackaged(): boolean;

  /**
   * The application root. Under Electron this is `app.getAppPath()`, which
   * points inside `app.asar` in a packaged build. Callers that need the
   * unpacked sibling derive it themselves.
   */
  getAppPath(): string;
}

/**
 * The host used when nothing has been injected: a plain Node process, never
 * packaged, rooted at the working directory.
 *
 * Correct for `nimbalyst-node` and for unit tests. Emphatically *not* correct
 * for Electron — see `assertHostRegistered` below.
 */
export const nodeHostEnvironment: HostEnvironment = {
  isPackaged: () => false,
  getAppPath: () => process.cwd(),
};

/**
 * Null means "nobody registered", which is a different state from "registered
 * the Node host". Keeping them distinct is what lets an Electron main process
 * fail loudly instead of quietly answering `isPackaged() === false`.
 */
let current: HostEnvironment | null = null;

/**
 * True only inside a real Electron main process.
 *
 * `process.versions.electron` alone is not enough: it is also set in the
 * renderer, where runtime code legitimately runs and nothing registers a host,
 * and under `ELECTRON_RUN_AS_NODE`, where the process is plain Node. Electron
 * sets `process.type` to `'browser'` in the main process only, and leaves it
 * undefined in the run-as-node case.
 */
function isElectronMainProcess(): boolean {
  const candidate = process as NodeJS.Process & { type?: string; versions: { electron?: string } };
  return Boolean(candidate.versions?.electron) && candidate.type === 'browser';
}

/**
 * Install the host implementation. Called once, early, by whichever package
 * owns the process. Passing null clears it, which is what test teardown wants.
 */
export function setHostEnvironment(host: HostEnvironment | null): void {
  current = host;
}

export function getHostEnvironment(): HostEnvironment {
  if (current) return current;

  // A packaged Electron build running on the Node default would report "not
  // packaged" and take the dev branch of every path resolution: the bundled
  // Claude binary would be looked up via an unchecked `require.resolve` that
  // can hand back a path inside app.asar, and the missing-binary error would be
  // swallowed as a development fallback. That is silent and shows up much later
  // as a misleading SDK error, so refuse to guess.
  if (isElectronMainProcess()) {
    throw new Error(
      'HostEnvironment was never registered in the Electron main process. '
      + 'packages/electron/src/main/hostEnvironment.ts must be imported before '
      + 'anything resolves a binary path.',
    );
  }

  return nodeHostEnvironment;
}
