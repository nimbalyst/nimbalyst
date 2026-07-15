/**
 * Per-suite Windows pre-push exclusion. Unlike a blanket platform skip, this
 * only exempts the exact files listed in windows-known-failing-suites.mjs --
 * any new suite (including ones added after this file) still runs and blocks
 * a local Windows push if it fails. Full suite (no exclusions) runs
 * unconditionally in CI and on macOS/Linux.
 *
 * The exclusion itself is wired into vitest.config.ts (see
 * NIMBALYST_PREPUSH_GATE there), not a vitest CLI --exclude flag: this repo's
 * vitest.config.ts uses `test.projects`, and each project defines its own
 * exclude array, so a CLI --exclude never reaches file discovery for either
 * project -- confirmed live (2026-07-15): excluded suites still ran and
 * failed even with --exclude passed on every one of them. Setting the env
 * var here, read by vitest.config.ts, is the only mechanism that actually
 * works for this config shape.
 *
 * Local Windows runs also cap worker concurrency (--maxWorkers 4). Live
 * verification (2026-07-15) showed the full suite, run at default (CPU-count)
 * concurrency, deterministically fails a handful of SQLite/PGLite-backed
 * suites (MigrationOrchestrator, PGLiteToSQLiteMigrator, ClaudeCodeImport)
 * plus one heavy jsdom suite, with errno-44 unhandled rejections --
 * reproduced across 3 separate full runs, and NOT fixed by retrying (the
 * same file failed on every retry attempt too). All of them pass 100% in
 * isolation. Root cause: too many concurrent workers racing for the same
 * native SQLite binding / file handles on Windows. --maxWorkers 4 (down from
 * the CPU-count default) eliminates the contention outright -- verified
 * clean (0 failures) across repeated full runs, both with and without retry,
 * confirming the concurrency cap is what actually fixes it, not retry.
 * CI (Ubuntu, dedicated runner, no observed contention) is unaffected.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WINDOWS_KNOWN_FAILING_SUITES } from './windows-known-failing-suites.mjs';

export function shouldExcludeKnownFailingSuites({ platform = process.platform, ci = process.env.CI } = {}) {
  return platform === 'win32' && !/^(1|true|yes)$/i.test(ci ?? '');
}

export function buildVitestArgs(opts = {}) {
  const args = ['vitest', '--run'];
  if (shouldExcludeKnownFailingSuites(opts)) {
    args.push('--maxWorkers', '4');
  }
  return args;
}

export function buildVitestEnv(opts = {}) {
  const env = {};
  if (shouldExcludeKnownFailingSuites(opts)) {
    env.NIMBALYST_PREPUSH_GATE = '1';
  }
  return env;
}

function main() {
  const args = buildVitestArgs();
  const env = { ...process.env, ...buildVitestEnv() };
  if (shouldExcludeKnownFailingSuites()) {
    process.stderr.write(
      `[prepush] Local Windows push: excluding ${WINDOWS_KNOWN_FAILING_SUITES.length} known-failing suite(s). ` +
      `See docs/WINDOWS_PREPUSH_GATE.md.
`,
    );
  }
  const child = spawn('npx', args, { stdio: 'inherit', shell: true, env });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
