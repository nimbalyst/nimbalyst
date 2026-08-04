import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { WINDOWS_KNOWN_FAILING_SUITES } from './windows-known-failing-suites.mjs';

/**
 * Keep the complete suite mandatory everywhere except an interactive Windows
 * push, where only the explicitly tracked nonportable files are excluded.
 */
export function shouldExcludeKnownFailingSuites({
  platform = process.platform,
  ci = process.env.CI,
} = {}) {
  return platform === 'win32' && !/^(1|true|yes)$/i.test(ci ?? '');
}

export function buildVitestArgs(options = {}) {
  const args = ['vitest', '--run'];
  if (shouldExcludeKnownFailingSuites(options)) {
    args.push('--maxWorkers', '4');
  }
  return args;
}

export function buildVitestEnv(options = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (shouldExcludeKnownFailingSuites(options)) {
    env.NIMBALYST_PREPUSH_GATE = '1';
  } else {
    delete env.NIMBALYST_PREPUSH_GATE;
  }
  return env;
}

function main() {
  const options = {};
  const excludesKnownFailures = shouldExcludeKnownFailingSuites(options);
  const args = buildVitestArgs(options);
  const env = buildVitestEnv(options);

  if (excludesKnownFailures) {
    process.stderr.write(
      `[prepush] Local Windows push: excluding ${WINDOWS_KNOWN_FAILING_SUITES.length} ` +
        'tracked nonportable suite(s); all other suites remain mandatory. ' +
        'See docs/WINDOWS_PREPUSH_GATE.md.\n',
    );
  }

  const child = spawn('npx', args, { stdio: 'inherit', shell: true, env });
  child.on('error', (error) => {
    process.stderr.write(`[prepush] ERROR: unable to start Vitest: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
