/**
 * Bootstrap file - Entry point for electron-vite.
 *
 * This file handles custom user-data-dir configuration, which must be set
 * before any electron-store usage.
 *
 * Note: electron-store is lazy-initialized in store.ts, so we can use static
 * imports without worrying about load order. The stores are created on first
 * access, which happens well after app.setPath() is called here.
 *
 * Native modules (node-pty) are handled via explicit path resolution in
 * TerminalSessionManager.ts using createRequire, which eliminates the need
 * for NODE_PATH manipulation and dynamic imports.
 *
 * V8 Memory Configuration:
 *   The heap memory limit can be configured via app-settings.json (maxHeapSizeMB).
 *   This must be applied before app.whenReady() via app.commandLine.appendSwitch().
 *
 * Usage:
 *   NIMBALYST_USER_DATA_DIR=/path/to/dir npm run dev
 *   or
 *   npm run dev -- --user-data-dir=/path/to/dir
 */

import { app } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { createUncaughtExceptionHandler } from './uncaughtException';

// CRITICAL: Strip inherited API keys from process.env before ANY downstream code
// (SDKs, providers, services) can observe them. See CLAUDE.md, section
// "Never Use Environment Variables as Implicit API Key Sources".
//
// A user had ANTHROPIC_API_KEY in a local .env file for unrelated work.
// Nimbalyst silently picked it up via process.env and billed the user's
// personal Anthropic account $100+ instead of their Nimbalyst subscription.
//
// As of claude-agent-sdk 0.2.111, `options.env` overlays `process.env`
// instead of replacing it, so per-session scrubbing in providers is no
// longer sufficient on its own. Stripping at the main-process boundary
// ensures no SDK or child process can ever inherit these keys.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Global uncaught exception handler - must be registered early. This catches
// errors that bubble up from async SDK operations. The throttling and the
// EPIPE feedback-loop guard (#502) live in ./uncaughtException, extracted so
// they can be unit tested.
process.on('uncaughtException', createUncaughtExceptionHandler());

// Parse --user-data-dir from command line args or environment variable
function getCustomUserDataDir(): string | undefined {
  // Check environment variable first (more reliable for npm scripts)
  if (process.env.NIMBALYST_USER_DATA_DIR) {
    return process.env.NIMBALYST_USER_DATA_DIR;
  }

  // Check command line args
  for (const arg of process.argv) {
    if (arg.startsWith('--user-data-dir=')) {
      return arg.substring('--user-data-dir='.length);
    }
  }

  return undefined;
}

const customUserDataDir = getCustomUserDataDir();

if (customUserDataDir) {
  // Set userData path before any electron-store instances are created.
  // With lazy initialization in store.ts, this is guaranteed to run first.
  app.setPath('userData', customUserDataDir);
  // Also set appData to parent directory for consistency
  app.setPath('appData', path.dirname(customUserDataDir));
  // console.log(`[Bootstrap] Using custom userData directory: ${customUserDataDir}`);
}

// Configure V8 heap memory limit from app settings
// This must happen before app.whenReady() for the flag to take effect
// Default to 4096MB (4GB) if not configured
try {
  const appSettings = new Store<{ maxHeapSizeMB?: number }>({ name: 'app-settings' });
  const maxHeapSizeMB = appSettings.get('maxHeapSizeMB', 4096);
  if (maxHeapSizeMB && maxHeapSizeMB > 0) {
    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${maxHeapSizeMB}`);
    // console.log(`[Bootstrap] V8 heap limit set to ${maxHeapSizeMB}MB`);
  }
} catch (error) {
  // If we can't read settings, use default
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
  // console.log('[Bootstrap] V8 heap limit set to 4096MB (default)');
}

// Enable CDP remote debugging in dev mode for Playwright extension testing.
// This allows `playwright connectOverCDP("http://localhost:9222")` to drive
// the running Nimbalyst instance without launching a separate Electron process.
if (process.env.NODE_ENV !== 'production') {
  const cdpPort = process.env.NIMBALYST_CDP_PORT || '9222';
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
  // console.log(`[Bootstrap] CDP remote debugging enabled on port ${cdpPort}`);
}

// Static import - no chunk boundary, no module duplication issues.
// This works because:
// 1. electron-store is lazy-initialized (store.ts)
// 2. node-pty uses explicit path resolution (TerminalSessionManager.ts)
import './index.js';
