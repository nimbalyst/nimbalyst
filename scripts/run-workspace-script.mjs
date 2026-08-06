/**
 * Runs one npm script across every workspace that defines it, with a bounded
 * job pool.
 *
 * `npm run <script> -ws` is strictly serial. For typecheck that means 24 cold
 * `tsc --noEmit` processes queued end to end on a 12-core machine, where two
 * packages own most of the wall clock and the other 22 wait behind them
 * (measured 2026-08-05: 66s serial, 29s at 8-way, floor set by the slowest
 * single package).
 *
 * Output is buffered per workspace and flushed when that workspace finishes, so
 * parallel runs stay readable instead of interleaving. Any failure prints that
 * workspace's full output and the run exits non-zero -- this backs the pre-push
 * gate, so a discovery bug must fail loudly rather than pass vacuously.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Expand the `workspaces` patterns from a root package.json into directories.
 * Only the trailing `/*` form npm uses here is supported; anything fancier
 * should fail loudly rather than silently match nothing.
 */
export function expandWorkspacePatterns(patterns, readDir) {
  return patterns.flatMap(pattern => {
    if (!pattern.includes('*')) return [pattern];
    if (!pattern.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const parent = pattern.slice(0, -2);
    return readDir(parent).map(name => `${parent}/${name}`);
  });
}

/** Workspace dirs that actually define `script`, in the order given. */
export function selectWorkspaces(dirs, script, readManifest) {
  return dirs.filter(dir => {
    const manifest = readManifest(dir);
    return Boolean(manifest?.scripts?.[script]);
  });
}

/** Bounded worker pool. Resolves to every task's result, in input order. */
export async function runPool(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function runScriptIn(dir, script, rootDir) {
  return new Promise(resolve => {
    const child = spawn(NPM, ['run', script], {
      cwd: path.join(rootDir, dir),
      env: process.env,
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.on('error', error => {
      resolve({ dir, code: 1, output: `failed to spawn ${NPM}: ${error.message}\n` });
    });
    child.on('close', code => {
      resolve({ dir, code: code ?? 1, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function main() {
  const script = process.argv[2];
  if (!script) {
    console.error('usage: run-workspace-script.mjs <script-name>');
    process.exit(1);
  }

  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const readManifest = dir => {
    try {
      return JSON.parse(readFileSync(path.join(rootDir, dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const root = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const dirs = expandWorkspacePatterns(root.workspaces ?? [], parent =>
    readdirSync(path.join(rootDir, parent), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name),
  );
  const targets = selectWorkspaces(dirs, script, readManifest);

  if (targets.length === 0) {
    console.error(`No workspace defines a "${script}" script.`);
    process.exit(1);
  }

  // tsc is single-threaded but memory-hungry; past ~8 the wall clock is set by
  // the slowest package anyway, so more concurrency only costs RAM.
  const jobs = Number(process.env.WORKSPACE_JOBS)
    || Math.max(1, Math.min(8, availableParallelism() - 1));
  console.log(`Running "${script}" in ${targets.length} workspaces, ${jobs} at a time`);

  const started = Date.now();
  const results = await runPool(targets, jobs, async dir => {
    const result = await runScriptIn(dir, script, rootDir);
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${dir}`);
    return result;
  });

  const failures = results.filter(result => result.code !== 0);
  for (const failure of failures) {
    console.error(`\n----- ${failure.dir} -----\n${failure.output}`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\n"${script}" failed in ${failures.length} of ${targets.length} workspaces (${seconds}s)`);
    process.exit(1);
  }
  console.log(`\n"${script}" passed in ${targets.length} workspaces (${seconds}s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
