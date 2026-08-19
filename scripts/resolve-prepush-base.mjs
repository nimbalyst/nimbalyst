#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function runGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Prefer canonical upstream so a fork branch is checked against its real source base. */
export function resolvePrepushBase(git = runGit) {
  for (const mainRef of ['upstream/main', 'origin/main']) {
    try {
      return git('merge-base', 'HEAD', mainRef).trim();
    } catch {
      // Try the next configured remote.
    }
  }
  return git('rev-parse', 'HEAD~1').trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(resolvePrepushBase());
}
