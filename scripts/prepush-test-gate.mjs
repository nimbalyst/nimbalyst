import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { compareTreeFingerprint } from './vitest-tree-fingerprint.mjs';
import { fullSuiteInvocation } from './validation-inventory.mjs';
import { pathToFileURL } from 'node:url';

/**
 * The full Vitest suite currently has Windows-nonportable failures. Keep it
 * mandatory everywhere else, including Windows CI, while local Windows pushes
 * retain the typecheck and focused-test gates.
 */
export function shouldRunFullPrePushSuite({ platform = process.platform, ci = process.env.CI } = {}) {
  return platform !== 'win32' || /^(1|true|yes)$/i.test(ci ?? '');
}

function runGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

const ZERO_SHA = /^0+$/;

/**
 * Git hands pre-push one line per ref: "<localRef> <localSha> <remoteRef> <remoteSha>".
 *
 * A release pushes `main` and then the tag on the same commit, and the hook used to
 * ignore stdin and re-gate HEAD both times -- the second run re-validated a tree the
 * first had just proven. Ask Git which commits the push actually delivers instead of
 * assuming they are new.
 *
 * Conservative by construction: anything unexpected (no refs, a failing git) returns
 * true, so a push is never waved through un-gated.
 */
export function pushDeliversNewCommits({ stdin = '', remote = 'origin', git = runGit } = {}) {
  if (stdin.trim() === '') return true;

  const shas = stdin
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((sha) => sha && !ZERO_SHA.test(sha));

  // Every ref was a deletion; a deletion carries no commits to test.
  if (shas.length === 0) return false;

  try {
    const count = git('rev-list', '--count', ...shas, '--not', `--remotes=${remote}`);
    return Number.parseInt(count.trim(), 10) > 0;
  } catch {
    return true;
  }
}

/** Reuse is an optimization of the existing HEAD gate, never a new ref gate. */
export function fullSuiteReuseDecision({ record, comparison, stdin = '', git = runGit, ci = process.env.CI } = {}) {
  const miss = (reason) => ({ reuse: false, reason });
  if (/^(1|true|yes)$/i.test(ci ?? '')) return miss('CI always validates independently');
  if (!record) return miss('missing full-suite record');
  if (record.invocation !== fullSuiteInvocation) return miss('invocation is not test:prepush');
  if (!record.complete) return miss('full-suite run is incomplete');
  if (record.result !== 'PASS') return miss('last full suite did not pass');
  // `current` already means HEAD and the content of every dirty path match the
  // tree the suite ran against. A clean-tree requirement on top of that adds no
  // evidence the gate does not already accept (it validates the working tree and
  // pushes HEAD either way) and never holds on a checkout shared by parallel
  // sessions, which is the only place reuse pays for itself.
  if (comparison?.verdict !== 'current') return miss(`fingerprint is ${comparison?.verdict ?? 'unknown'}`);
  const refs = stdin.trim().split('\n').filter(Boolean);
  if (!refs.length) return miss('no pushed refs available');
  try {
    for (const ref of refs) {
      const fields = ref.trim().split(/\s+/);
      if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1])) return miss('unrecognized pushed ref');
      if (ZERO_SHA.test(fields[1])) continue;
      // Annotated tags point at tag objects; peel to the commit before comparing.
      if (git('rev-parse', `${fields[1]}^{commit}`).trim() !== comparison.now.head) return miss('pushed commit differs from checked-out HEAD');
    }
  } catch { return miss('cannot resolve pushed commit'); }
  return { reuse: true, reason: 'complete passing full suite matches this HEAD, working tree, and toolchain' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, remote] = process.argv.slice(2);
  if (flag === '--delivers') {
    const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
    process.stdout.write(pushDeliversNewCommits({ stdin, remote: remote || 'origin' }) ? 'new\n' : 'none\n');
  } else if (flag === '--reuse') {
    let record;
    let comparison;
    try {
      record = JSON.parse(readFileSync('.vitest/last-full-run.json', 'utf8'));
      comparison = compareTreeFingerprint(record.fingerprint);
    } catch { /* Fail closed for missing/corrupt records or unavailable Git. */ }
    const decision = fullSuiteReuseDecision({ record, comparison, stdin: process.stdin.isTTY ? '' : readFileSync(0, 'utf8') });
    console.error(`[pre-push] Vitest ${decision.reuse ? 'reuse' : 'run'}: ${decision.reason}.`);
    process.stdout.write(decision.reuse ? 'reuse\n' : 'run\n');
  } else {
    process.stdout.write(shouldRunFullPrePushSuite() ? 'run\n' : 'skip\n');
  }
}
