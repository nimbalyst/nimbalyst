#!/usr/bin/env node

/**
 * Wrapper script to load .env file before running electron-builder
 */

const path = require('path');
const { execSync, spawn } = require('child_process');

// Normalize then validate extraResources before building. Mac build scripts
// go through this wrapper directly, so hoisted workspace deps must be linked
// into packages/electron/node_modules here before validation runs.
try {
  const cwd = path.join(__dirname, '..');
  for (const command of [
    'node build/normalize-extra-resources.js',
    'node build/validate-extra-resources.js',
  ]) {
    execSync(command, {
      cwd,
      stdio: 'inherit',
    });
  }
} catch {
  process.exit(1);
}

// Get command line arguments (everything after the script name)
const args = process.argv.slice(2);

// Prove the pinned Electron runtime can actually load the native modules
// before spending a full build on it. Only meaningful for a same-arch,
// same-platform target: node_modules holds host-arch binaries (and after
// `install-app-deps` for a cross-arch target, target-arch ones the host
// Electron can't load), so a cross build would fail this for the wrong
// reason. Skipping is announced rather than silent.
const PLATFORM_FLAGS = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' };
const ARCH_FLAGS = { '--x64': 'x64', '--arm64': 'arm64', '--armv7l': 'arm', '--ia32': 'ia32' };
const targetPlatform = args.map((a) => PLATFORM_FLAGS[a]).find(Boolean) || process.platform;
const targetArch = args.includes('--universal')
  ? 'universal'
  : args.map((a) => ARCH_FLAGS[a]).find(Boolean) || process.arch;

if (targetPlatform === process.platform && targetArch === process.arch) {
  try {
    execSync('node build/verify-native-runtime.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    console.error(
      'Native runtime verification failed -- the pinned Electron cannot load better-sqlite3 ' +
      'and/or node-pty. Fix the install (npm run postinstall in packages/electron) before building; ' +
      'shipping this would produce an app that cannot open its database or start a terminal.',
    );
    process.exit(1);
  }
} else {
  console.log(
    `[build-with-env] Skipping native runtime verification: cross build ` +
    `(${process.platform}-${process.arch} host -> ${targetPlatform}-${targetArch} target).`,
  );
}

// Store SKIP_NOTARIZE before loading .env (which might override it)
const skipNotarize = process.env.SKIP_NOTARIZE;

// Load environment variables from .env file
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Restore SKIP_NOTARIZE if it was set before dotenv
if (skipNotarize) {
  process.env.SKIP_NOTARIZE = skipNotarize;
}

// Run electron-builder with the loaded environment
const electronBuilder = spawn('npx', ['electron-builder', ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

electronBuilder.on('close', (code) => {
  process.exit(code);
});
