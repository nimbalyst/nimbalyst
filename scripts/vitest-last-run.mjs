#!/usr/bin/env node
/**
 * `npm run test:last` -- print the last vitest run, and say whether it is still
 * true.
 *
 * This used to be `cat .vitest/last-run.log`, which answers "what failed?" but
 * not "does that still hold?". Without the second answer the safe-looking move
 * is always to re-run a suite that takes minutes, so the log got ignored and
 * the cost got paid twice. The verdict banner is the whole point of this file:
 * on CURRENT there is nothing to learn from running again.
 */

import * as fs from 'fs';
import * as path from 'path';
import { compareTreeFingerprint } from './vitest-tree-fingerprint.mjs';

const LOG_DIR = '.vitest';
const logPath = path.join(LOG_DIR, 'last-run.log');
const statePath = path.join(LOG_DIR, 'last-run.json');

if (!fs.existsSync(logPath)) {
  console.log('No recorded test run. Run: npm run test:prepush');
  process.exit(0);
}

let state = null;
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
} catch {
  // Pre-fingerprint log, or a run that died before writing state.
}

const { verdict, changed } = compareTreeFingerprint(state?.fingerprint ?? null);
const failing = state?.failingFiles ?? [];

const banner = [];
let fullState;
try { fullState = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'last-full-run.json'), 'utf8')); } catch {}
banner.push(`Last invocation: ${state?.invocation ?? 'unknown'} (${state?.complete ? 'complete' : 'incomplete/legacy'})`);
if (fullState) banner.push(`Last full suite: ${fullState.result}, ${fullState.complete ? 'complete' : 'incomplete'}, ${fullState.finishedAt ?? fullState.startedAt}`);
else banner.push('No separate full-suite record.');
if (verdict === 'current') {
  banner.push('CURRENT -- the working tree is unchanged since this run.');
  banner.push('These results still hold. Re-running the suite cannot tell you anything new.');
  if (failing.length > 0) {
    banner.push(`Fix the ${failing.length} failing file(s) below, then rerun ONLY those.`);
  }
} else if (verdict === 'stale') {
  banner.push(`STALE -- ${changed.length} path(s) changed since this run:`);
  for (const c of changed.slice(0, 20)) banner.push(`  ${c.path} (${c.change})`);
  if (changed.length > 20) banner.push(`  ... and ${changed.length - 20} more`);
  banner.push('');
  banner.push(
    failing.length > 0
      ? `Rerun only the affected files, not the suite: npx vitest --run ${failing.join(' ')}`
      : 'Rerun only the files your edits affect, not the whole suite.',
  );
} else {
  banner.push('UNKNOWN -- this run recorded no tree fingerprint, so it cannot be trusted as current.');
}

const width = Math.max(...banner.map((l) => l.length), 0);
console.log('='.repeat(Math.min(width, 100)));
for (const line of banner) console.log(line);
console.log(`${'='.repeat(Math.min(width, 100))}\n`);

console.log(fs.readFileSync(logPath, 'utf-8'));
