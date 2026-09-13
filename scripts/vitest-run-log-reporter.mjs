/**
 * Writes the outcome of every vitest run to `.vitest/last-run.log`.
 *
 * The suite takes minutes. Losing which tests failed -- to a dot reporter, a
 * truncated pipe, a closed terminal -- means paying that cost again to learn
 * something the run already knew. This reporter makes a re-run never necessary
 * just to re-read the result: the log always holds the last run's failures,
 * with names, files, messages and a ready-to-paste command to rerun only them.
 *
 * Always writes, pass or fail, so "what did the last run say?" has an answer
 * even when the answer is "green".
 *
 * Uses the Vitest 4 reporter API (`onTestRunEnd`). The v1/v2 `onFinished` hook
 * is gone -- a reporter implementing it loads without error and silently never
 * runs, which is exactly the failure this file exists to prevent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { isFullSuiteInvocation } from './validation-inventory.mjs';
import { computeTreeFingerprint } from './vitest-tree-fingerprint.mjs';

const LOG_DIR = '.vitest';
const LOG_FILE = 'last-run.log';
const STATE_FILE = 'last-run.json';
const FULL_STATE_FILE = 'last-full-run.json';

function writeState(file, state) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const target = path.join(LOG_DIR, file);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, target);
}

// Vitest colourises expected/received diffs. Escape codes are noise in a file
// that gets opened in an editor as often as it gets `cat`ed.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const plain = (value) => String(value).replace(ANSI, '');

export default class RunLogReporter {
  onTestRunStart() {
    this.startedAt = new Date();
    this.invocation = process.argv.slice(2);
    this.fullSuite = isFullSuiteInvocation(this.invocation);
    this.runId = randomUUID();
    // Invalidate an older success before running. A killed/aborted process must
    // not leave that success eligible for reuse on an unchanged checkout.
    if (this.fullSuite) writeState(FULL_STATE_FILE, {
      runId: this.runId, complete: false, result: 'RUNNING',
      invocation: this.invocation.join(' '), startedAt: this.startedAt.toISOString(),
    });
    // Fingerprint the tree the run is about to test, not the tree it finishes
    // against. An edit made mid-run genuinely does invalidate these results,
    // and recording the start state is what lets `test:last` say so.
    try {
      this.fingerprint = computeTreeFingerprint();
    } catch {
      this.fingerprint = null;
    }
  }

  onTestRunEnd(testModules = [], unhandledErrors = [], reason = 'passed') {
    const lines = [];
    const failuresByModule = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const testModule of testModules) {
      const moduleFailures = [];
      for (const test of testModule.children.allTests()) {
        const result = test.result();
        if (result.state === 'passed') {
          passed++;
        } else if (result.state === 'failed') {
          failed++;
          moduleFailures.push({
            name: test.fullName,
            errors: (result.errors ?? []).map((e) => ({
              message: e?.message ?? String(e),
              diff: e?.diff ?? null,
            })),
          });
        } else if (result.state === 'skipped') {
          skipped++;
        }
      }
      if (moduleFailures.length > 0) {
        failuresByModule.push({ moduleId: testModule.moduleId, tests: moduleFailures });
      }
    }

    const collectionErrors = testModules.flatMap((module) => module.errors());
    const complete = ['passed', 'failed'].includes(reason) && testModules.length > 0
      && collectionErrors.length === 0;
    const ok = reason === 'passed' && failed === 0 && unhandledErrors.length === 0
      && collectionErrors.length === 0 && passed > 0;
    const errors = [...unhandledErrors, ...collectionErrors];
    const rel = (p) => path.relative(process.cwd(), p);

    // A one-file run overwrites a full-suite run's record. Recording the argv
    // makes a partial log say so, instead of quietly reading as "everything
    // passed" and hiding the failures the full run had already found.
    lines.push(`vitest ${this.invocation.join(' ') || 'run'}`);
    lines.push(`started:  ${this.startedAt?.toISOString() ?? 'unknown'}`);
    lines.push(`finished: ${new Date().toISOString()}`);
    lines.push(`reason:   ${reason}`);
    lines.push(
      `result:   ${ok ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed, ${skipped} skipped)`,
    );
    lines.push(
      `tree:     ${this.fingerprint ? `${this.fingerprint.digest} (run "npm run test:last" to check this still matches)` : 'unknown (no git repository)'}`,
    );
    lines.push('');

    if (errors.length > 0) {
      lines.push(`--- ${errors.length} unhandled error(s) ---`);
      for (const err of errors) {
        lines.push(err?.stack ?? err?.message ?? String(err));
        lines.push('');
      }
    }

    if (failed === 0) {
      lines.push('No failing tests.');
    } else {
      lines.push(`--- ${failed} failing test(s) ---`);
      lines.push('');
      for (const { moduleId, tests } of failuresByModule) {
        for (const test of tests) {
          lines.push(`FAIL ${rel(moduleId)}`);
          lines.push(`     ${test.name}`);
          for (const err of test.errors) {
            for (const line of plain(err.message).split('\n')) lines.push(`       ${line}`);
            if (err.diff) {
              for (const line of plain(err.diff).split('\n')) lines.push(`       ${line}`);
            }
          }
          lines.push('');
        }
      }
      lines.push('--- rerun only these ---');
      lines.push(`npx vitest --run ${failuresByModule.map((f) => rel(f.moduleId)).join(' ')}`);
    }

    lines.push('');

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOG_DIR, LOG_FILE), lines.join('\n'), 'utf-8');
      // The machine-readable half. `test:last` reads this to decide whether the
      // human log above is still describing the code on disk.
      const state = {
        runId: this.runId,
        startedAt: this.startedAt?.toISOString() ?? null,
        finishedAt: new Date().toISOString(),
        invocation: this.invocation.join(' '),
        complete,
        reason,
        result: ok ? 'PASS' : 'FAIL',
        counts: { passed, failed, skipped },
        files: testModules.length,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt.getTime()) / 1000 : null,
        failingFiles: failuresByModule.map((f) => rel(f.moduleId)),
        fingerprint: this.fingerprint ?? null,
      };
      writeState(STATE_FILE, state);
      if (this.fullSuite) {
        const current = JSON.parse(fs.readFileSync(path.join(LOG_DIR, FULL_STATE_FILE), 'utf8'));
        // A later full run owns the record, even if an older run finishes last.
        if (current.runId === this.runId) writeState(FULL_STATE_FILE, state);
      }
      if (!ok) {
        console.error(`\n[run-log] ${failed} failure(s) recorded in ${LOG_DIR}/${LOG_FILE}`);
        console.error('[run-log] review with: npm run test:last');
      }
    } catch (err) {
      // Never let logging fail a run.
      console.error('[run-log] could not write run log:', err?.message ?? err);
    }
  }
}
