import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Installs the repo git hooks by pointing core.hooksPath at .githooks.
// Runs standalone (`npm run hooks:install`) and automatically via the
// `prepare` lifecycle on `npm install`. It must NEVER fail the install:
// in CI checkouts, published tarballs, or any non-git context it warns
// and exits 0 rather than throwing.

function skip(reason) {
  console.warn(`[git-hooks] Skipped (${reason}).`);
  process.exit(0);
}

function ensureExecutable(dirPath) {
  for (const entry of readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      ensureExecutable(fullPath);
      continue;
    }
    try {
      chmodSync(fullPath, 0o755);
    } catch {
      // chmod may be denied / a no-op on some filesystems (e.g. Windows);
      // git still honors the hook there, so this is non-fatal.
    }
  }
}

let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
} catch {
  skip('not a git repository, or git is unavailable');
}

const hooksDir = path.join(repoRoot, '.githooks');
if (!existsSync(hooksDir)) {
  skip(`hooks directory not found at ${hooksDir}`);
}

ensureExecutable(hooksDir);

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
} catch {
  skip('could not set core.hooksPath');
}

console.log('[git-hooks] Installed repo hooks (core.hooksPath -> .githooks).');

// Git opens its SSH connection BEFORE running pre-push. The full gate can leave
// it idle for several minutes, so keep it alive while the local checks run.
// This must be configured before the next push, not exported inside the hook.
try {
  const readConfig = (key) => {
    try {
      return execFileSync('git', ['config', '--get', key], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      if (error.status === 1) return undefined;
      throw error;
    }
  };
  const variant = process.env.GIT_SSH_VARIANT ?? readConfig('ssh.variant');
  if (
    process.env.GIT_SSH_COMMAND !== undefined ||
    process.env.GIT_SSH !== undefined ||
    readConfig('core.sshCommand') !== undefined ||
    (variant !== undefined && !['ssh', 'auto'].includes(variant))
  ) {
    console.log('[git-hooks] Kept existing SSH transport settings.');
  } else {
    execFileSync('git', ['config', '--local', 'core.sshCommand', 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=6'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    console.log('[git-hooks] Enabled repository SSH keepalives for long pre-push checks.');
  }
} catch {
  console.warn('[git-hooks] Could not configure SSH keepalives; hooks are installed.');
}
