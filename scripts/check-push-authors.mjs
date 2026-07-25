#!/usr/bin/env node
// Refuse to push commits authored by test-fixture identities. The vitest suite
// builds real git repos (GitCommitService.test.ts and friends); on 2026-07-22 a
// run escaped its temp sandbox during a release and pushed ten fixture commits
// ("seed", "hook must reject", author "Test User") to public main. Any outgoing
// commit with one of these identities is an escaped fixture, never real work.
import { execFileSync } from 'node:child_process';

const FORBIDDEN_NAMES = new Set(['Test', 'Test User', 'Your Name']);
const FORBIDDEN_EMAIL_PATTERN = /(^test@|@example\.(com|net|org)$|@test\.?$)/i;

export function findForbiddenAuthors(commits) {
  return commits.filter(
    ({ name, email }) => FORBIDDEN_NAMES.has(name) || FORBIDDEN_EMAIL_PATTERN.test(email),
  );
}

export function parseGitLog(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, name, email, subject] = line.split('\x1f');
      return { sha, name, email, subject };
    });
}

function resolveRange() {
  if (process.argv[2]) return process.argv[2];
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      encoding: 'utf8',
    }).trim();
    return `${base}..HEAD`;
  } catch {
    return 'HEAD~1..HEAD';
  }
}

function main() {
  const range = resolveRange();
  const log = execFileSync(
    'git',
    ['log', '--format=%H\x1f%an\x1f%ae\x1f%s', range],
    { encoding: 'utf8' },
  );
  const offenders = findForbiddenAuthors(parseGitLog(log));
  if (offenders.length > 0) {
    console.error('[check-push-authors] ERROR: refusing to push commits with test-fixture authors:');
    for (const { sha, name, email, subject } of offenders) {
      console.error(`  ${sha.slice(0, 9)} ${name} <${email}> ${subject}`);
    }
    console.error('[check-push-authors] These look like escaped unit-test commits (see 2026-07-22 incident).');
    console.error('[check-push-authors] Drop them (git rebase --onto / git reset to the last real commit) before pushing.');
    process.exit(1);
  }
  console.log(`[check-push-authors] OK: no test-fixture authors in ${range}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
