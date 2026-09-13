/**
 * The headless host: this package's answers to everything the runtime asks its
 * host for.
 *
 * Registration is a module-import side effect, matching
 * `packages/electron/src/main/hostEnvironment.ts`. ESM hoists static imports
 * above the importing module's body, so a host registered from inside a
 * function cannot beat its own imports -- ordering has to come from import
 * position. Import this module before anything that resolves a binary path.
 *
 * Runtime's `getHostEnvironment()` already falls back to a Node default, so this
 * is not strictly required to avoid a throw. It is registered anyway because the
 * default roots `getAppPath()` at `process.cwd()`, which for this CLI is the
 * user's workspace -- and `getAppPath()` is used to build the `NODE_PATH` the
 * Claude subprocess inherits. Rooting it at the workspace would point the SDK's
 * module resolution at whatever `node_modules` the user's repo happens to have.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setHostEnvironment,
  type HostEnvironment,
} from '@nimbalyst/runtime/host/hostEnvironment';

const require = createRequire(import.meta.url);

/** This package's own root: `<...>/packages/node`, whether running from src or dist. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/host/ or src/host/ -> the package root two levels up.
  return path.resolve(here, '../..');
}

export const nodeHostEnvironment: HostEnvironment = {
  agentConfiguration: 'explicit-only',
  // No asar, ever. Every packaged-path branch in the runtime resolves nowhere
  // from here, so answering true would send binary resolution into a directory
  // that does not exist.
  isPackaged: () => false,
  getAppPath: () => packageRoot(),
};

export function registerNodeHostEnvironment(): void {
  setHostEnvironment(nodeHostEnvironment);
}

/**
 * Resolve the Claude Agent SDK's bundled native binary for this platform.
 *
 * The runtime has its own copy of this logic in
 * `runtime/src/electron/claudeCodeEnvironment.ts`, and under the Node build that
 * copy CANNOT work: its non-packaged branch calls `require.resolve(...)`, which
 * is undefined in the plain ESM `dist-node/` emits, and the resulting
 * `ReferenceError` is swallowed by a `catch { return undefined }`. The visible
 * symptom is not an error -- it is `pathToClaudeCodeExecutable: undefined`, and
 * the SDK quietly resolving its own binary instead. That works today and hides
 * the fact that a host-configured path is being ignored, so we resolve it here
 * and hand it over as a custom path.
 *
 * Reported to the runtime slice rather than fixed there; see the session report.
 */
export function resolveClaudeBinary(): string | undefined {
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const resolved = require.resolve(`${packageName}/${binaryName}`);
    return existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
