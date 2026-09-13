/**
 * Electron's answer to the runtime host capability contract.
 *
 * `packages/runtime` used to import `electron` directly to read `app.isPackaged`
 * and `app.getAppPath()`. Those were the only two Electron dependencies in the
 * package, and they blocked every non-Electron host. Runtime now asks an
 * injected `HostEnvironment`; this is the Electron one.
 *
 * Both members read `app` lazily at call time rather than capturing at module
 * load, so registering this before `app.whenReady()` is safe.
 */

import { app } from 'electron';
import { setHostEnvironment, type HostEnvironment } from '@nimbalyst/runtime/host/hostEnvironment';

export const electronHostEnvironment: HostEnvironment = {
  isPackaged: () => app.isPackaged,
  getAppPath: () => app.getAppPath(),
};

/**
 * Install the Electron host into runtime. Must run before anything resolves a
 * Claude binary path or builds SDK options.
 */
export function registerElectronHostEnvironment(): void {
  setHostEnvironment(electronHostEnvironment);
}

// Registered as a side effect of importing this module, not from a caller's
// function body.
//
// ESM hoists every static import above the importing module's statements, so
// `bootstrap.ts` calling this in its body could NOT beat its own
// `import './index.js'` -- the entire main graph evaluates first. Ordering here
// is by import position instead: bootstrap imports this module near the top of
// its import list and `./index.js` last, so this runs first for real.
//
// Runtime now throws rather than defaulting when an Electron main process
// reaches an unregistered host, so a future reordering fails loudly instead of
// silently taking the unpackaged branch.
registerElectronHostEnvironment();
