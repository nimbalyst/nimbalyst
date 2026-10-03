#!/usr/bin/env node
/**
 * Seed the "Run later" + queued-prompt demo scenario into the ALREADY-RUNNING
 * dev instance (#1497).
 *
 * Drives the live window over CDP rather than launching its own Electron, so
 * the scenario appears in the app you are already looking at. Dev builds
 * already enable remote debugging in `src/main/bootstrap.ts` (port 9222 by
 * default, overridable with NIMBALYST_CDP_PORT), so nothing extra is needed.
 *
 * It deliberately does NOT touch the database directly -- PGLite and
 * better-sqlite3 both take an exclusive lock, and a second process opening the
 * file risks corruption. Everything goes through the renderer's own IPC.
 *
 * Usage:
 *   node scripts/seed-run-later-demo.mjs
 *   node scripts/seed-run-later-demo.mjs --port 9223
 *   node scripts/seed-run-later-demo.mjs --reset <sessionId>
 *
 * If it cannot connect, the usual cause is another process squatting the CDP
 * port, which makes the app skip binding it silently. Start dev on a free one:
 *   NIMBALYST_CDP_PORT=9223 npm run dev
 */

import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = { port: process.env.NIMBALYST_CDP_PORT || '9222', reset: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = argv[++i];
    else if (argv[i] === '--reset') args.reset = argv[++i];
  }
  return args;
}

const { port, reset } = parseArgs(process.argv.slice(2));
const endpoint = `http://127.0.0.1:${port}`;

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
} catch (error) {
  console.error(`Could not reach Nimbalyst over CDP at ${endpoint}.`);
  console.error(`  ${error.message.split('\n')[0]}`);
  console.error('');
  console.error('Checks:');
  console.error('  1. Is the dev app running? (cd packages/electron && npm run dev)');
  console.error(`  2. Is something else holding port ${port}? A stale listener makes the`);
  console.error('     app skip binding it. Restart dev on a free port:');
  console.error(`       NIMBALYST_CDP_PORT=9223 npm run dev`);
  console.error('       node scripts/seed-run-later-demo.mjs --port 9223');
  process.exit(1);
}

// The renderer is the only page target that exposes __testHelpers; devtools
// windows and extension hosts also show up as pages.
const pages = browser.contexts().flatMap((context) => context.pages());
let target = null;
for (const page of pages) {
  const hasHelpers = await page
    .evaluate(() => typeof window.__testHelpers?.seedScheduleLaterDemo === 'function')
    .catch(() => false);
  if (hasHelpers) {
    target = page;
    break;
  }
}

if (!target) {
  console.error(`Connected to ${endpoint}, but no window exposed __testHelpers.`);
  console.error(`Pages seen: ${pages.length}.`);
  console.error('__testHelpers is dev-only, and only attaches after the app finishes loading.');
  console.error('If you just edited renderer code, reload the window (Ctrl+R) so the new bundle loads.');
  await browser.close();
  process.exit(1);
}

try {
  if (reset) {
    const result = await target.evaluate(
      (sessionId) => window.__testHelpers.resetScheduleLaterDemo(sessionId),
      reset,
    );
    console.log(`Reset session ${reset}:`, JSON.stringify(result));
  } else {
    const result = await target.evaluate(() => window.__testHelpers.seedScheduleLaterDemo());
    console.log(JSON.stringify(result, null, 2));
    if (result?.note) console.log(`\nNote: ${result.note}`);
    console.log(`\nTo undo: node scripts/seed-run-later-demo.mjs --reset ${result.sessionId}`);
  }
} finally {
  // Only detaches the CDP client; it does not close the user's app.
  await browser.close();
}
