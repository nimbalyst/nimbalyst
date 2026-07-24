#!/usr/bin/env node

/**
 * Validates that all extraResources 'from' paths in the electron-builder
 * config actually exist before building. electron-builder silently skips
 * missing sources, which produces broken builds with no error.
 *
 * Also covers platform-specific extraResources (build.mac/win/linux.extraResources)
 * and the `${arch}` macro (expanded via the BUILD_ARCH env var set by CI).
 */

const fs = require('fs');
const path = require('path');

const packageDir = path.join(__dirname, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);

const buildArch = process.env.BUILD_ARCH || process.arch;

// Map electron-builder platform name -> Node.js platform value used in the
// claude-agent-sdk per-platform package name (e.g. darwin, win32, linux).
const PLATFORM_MACROS = { mac: 'darwin', win: 'win32', linux: 'linux' };

// Only validate the scope matching the current runner's platform. CI runs
// `build:linux` on a Linux runner, `build:mac` on macOS, `build:win` on
// Windows, and only installs the host-platform's per-platform packages --
// walking every scope would flag other-platform binaries as missing even
// though they are not needed for this build.
const targetPlatform = process.env.BUILD_PLATFORM || process.platform;

function expandMacros(str, platformMacro) {
  return str
    .replace(/\$\{arch\}/g, buildArch)
    .replace(/\$\{os\}/g, platformMacro || process.platform);
}

// Mirror of getCodexTargetTriple in packages/runtime/src/ai/server/providers/codex/codexBinaryPath.ts.
// Keep these in sync: the validator must check the same vendored-binary path
// the runtime resolves at runtime.
function codexTargetTriple(plat, arch) {
  if (plat === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }
  if (plat === 'linux') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }
  if (plat === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  }
  return undefined;
}

function collectEntries() {
  const out = [];
  const top = packageJson.build?.extraResources;
  if (Array.isArray(top)) {
    for (const entry of top) {
      out.push({ entry, scope: 'top-level', platformMacro: undefined });
    }
  }
  for (const [key, platformMacro] of Object.entries(PLATFORM_MACROS)) {
    if (platformMacro !== targetPlatform) continue;
    const list = packageJson.build?.[key]?.extraResources;
    if (Array.isArray(list)) {
      for (const entry of list) {
        out.push({ entry, scope: `mac/win/linux = ${key}`, platformMacro });
      }
    }
  }
  return out;
}

const allEntries = collectEntries();
if (allEntries.length === 0) {
  console.log('[validate-extra-resources] No extraResources config found, skipping.');
  process.exit(0);
}

const missing = [];

for (const { entry, scope, platformMacro } of allEntries) {
  const rawFrom = typeof entry === 'string' ? entry : entry.from;
  if (!rawFrom) continue;
  const from = expandMacros(rawFrom, platformMacro);

  const resolved = path.resolve(packageDir, from);
  if (!fs.existsSync(resolved)) {
    missing.push({ from: rawFrom, expanded: from, resolved, scope });
  }
}

if (missing.length > 0) {
  console.error('\n[validate-extra-resources] ERROR: Missing extraResources sources!');
  console.error('electron-builder silently skips these, producing a broken build.\n');
  for (const { from, expanded, resolved, scope } of missing) {
    console.error(`  scope: ${scope}`);
    console.error(`  from: "${from}"`);
    if (expanded !== from) console.error(`  expanded: "${expanded}" (BUILD_ARCH=${buildArch})`);
    console.error(`  resolved: ${resolved}\n`);
  }
  console.error(
    'Common causes:\n' +
    ' - npm workspace hoisting changed after a dependency upgrade.\n' +
    ' - cross-arch install step did not run or installed to the wrong location.\n' +
    ' - BUILD_ARCH env var not set to the target arch for this build.\n'
  );
  process.exit(1);
}

// Packages whose postinstall fetches an external binary, OR whose binary
// is installed by a separate step (cross-arch claude-agent-sdk-*). The
// directory existing is not enough -- verify the actual executable.
const binaryChecks = [];

// @vscode/ripgrep: postinstall downloads rg/rg.exe into bin/. If the
// package exists but bin/rg{,.exe} is missing, postinstall was skipped
// (e.g. --ignore-scripts in CI).
for (const { entry, platformMacro } of allEntries) {
  const rawFrom = typeof entry === 'string' ? entry : entry.from;
  if (!rawFrom) continue;
  if (rawFrom.endsWith('@vscode/ripgrep')) {
    const dir = path.resolve(packageDir, expandMacros(rawFrom, platformMacro));
    binaryChecks.push({
      label: '@vscode/ripgrep',
      dir,
      binDir: path.join(dir, 'bin'),
      accept: (f) => f === 'rg' || f === 'rg.exe',
      cause: '@vscode/ripgrep postinstall was skipped (e.g. npm ci --ignore-scripts)',
      fix: 'run `node node_modules/@vscode/ripgrep/lib/postinstall.js --force`',
    });
  }
  // claude-agent-sdk-<platform>-<arch>: the native `claude` binary sits at
  // the package root. If the package exists but the binary is missing, the
  // cross-arch install step broke or npm pruned the cpu-mismatched optional
  // dep. This is the Intel Mac failure mode where users saw "native CLI
  // binary for darwin-x64 not found".
  const sdkMatch = rawFrom.match(/@anthropic-ai\/claude-agent-sdk-([a-z0-9]+)-\$\{arch\}$/);
  if (sdkMatch) {
    const plat = sdkMatch[1];
    const dir = path.resolve(packageDir, expandMacros(rawFrom, platformMacro));
    const binName = plat === 'win32' ? 'claude.exe' : 'claude';
    binaryChecks.push({
      label: `@anthropic-ai/claude-agent-sdk-${plat}-${buildArch}`,
      dir,
      binDir: dir,
      accept: (f) => f === binName,
      cause: 'cross-arch install step failed to land the binary at root node_modules/, or npm pruned the cpu-mismatched optional dep',
      fix: `npm install --no-save --force @anthropic-ai/claude-agent-sdk-${plat}-${buildArch}@<sdk-version>`,
    });
  }
  // @openai/codex-<platform>-<arch>: the native `codex` binary sits at
  // vendor/<target-triple>/bin/codex on codex-sdk 0.131+ (older layouts used
  // vendor/<triple>/codex/ or the triple dir directly). Keep these candidates
  // in sync with codexBinaryPath.ts. Same cross-arch failure mode as
  // claude-agent-sdk -- if the package exists but the vendored binary is
  // missing, the cross-arch install step broke.
  const codexMatch = rawFrom.match(/@openai\/codex-([a-z0-9]+)-\$\{arch\}$/);
  if (codexMatch) {
    const plat = codexMatch[1];
    const dir = path.resolve(packageDir, expandMacros(rawFrom, platformMacro));
    const triple = codexTargetTriple(plat, buildArch);
    const binName = plat === 'win32' ? 'codex.exe' : 'codex';
    binaryChecks.push({
      label: `@openai/codex-${plat}-${buildArch}`,
      dir,
      candidatePaths: triple ? [
        path.join(dir, 'vendor', triple, 'bin', binName),
        path.join(dir, 'vendor', triple, 'codex', binName),
        path.join(dir, 'vendor', triple, binName),
      ] : [],
      cause: triple
        ? `cross-arch install step failed to land the codex binary at vendor/${triple}/, or npm pruned the cpu-mismatched optional dep`
        : `unsupported codex target for plat=${plat}, arch=${buildArch}`,
      fix: `npm install --no-save --force @openai/codex-${plat}-${buildArch}@<codex-version>`,
    });
  }
  // node-pty: the loadable native module must exist at one of three paths
  // (build/Release, build/Debug, prebuilds/<platform>-<arch>) for the
  // current build target. The upstream npm package only ships prebuilds
  // for darwin and win32, so Linux builds must compile from source --
  // electron-builder install-app-deps with buildFromSource=false silently
  // skips that, producing a node-pty dir with no Linux binary inside.
  if (rawFrom.endsWith('/node-pty')) {
    const dir = path.resolve(packageDir, expandMacros(rawFrom, platformMacro));
    const ptyTarget = `${targetPlatform}-${buildArch}`;
    binaryChecks.push({
      label: `node-pty (${ptyTarget})`,
      dir,
      candidatePaths: [
        path.join(dir, 'build', 'Release', 'pty.node'),
        path.join(dir, 'build', 'Debug', 'pty.node'),
        path.join(dir, 'prebuilds', ptyTarget, 'pty.node'),
      ],
      cause: `no loadable pty.node found for ${ptyTarget}; @electron/rebuild ran with buildFromSource=false and the upstream npm package ships no prebuild for this platform`,
      fix: `npx @electron/rebuild --force --module-dir node_modules/node-pty --types prod --version <electron-version>`,
    });
  }
}

const binaryFailures = [];
for (const check of binaryChecks) {
  let hasBinary;
  if (check.candidatePaths) {
    hasBinary = check.candidatePaths.some((p) => fs.existsSync(p));
  } else {
    hasBinary = fs.existsSync(check.binDir)
      && fs.readdirSync(check.binDir).some(check.accept);
  }
  if (!hasBinary) binaryFailures.push(check);
}

if (binaryFailures.length > 0) {
  console.error('\n[validate-extra-resources] ERROR: Expected binaries are missing from extraResources!');
  console.error('The package directory exists but the binary inside does not.\n');
  for (const f of binaryFailures) {
    console.error(`  package: ${f.label}`);
    console.error(`  dir:     ${f.dir}`);
    console.error(`  cause:   ${f.cause}`);
    console.error(`  fix:     ${f.fix}\n`);
  }
  process.exit(1);
}

console.log(
  `[validate-extra-resources] All ${allEntries.length} extraResources sources exist` +
  (binaryChecks.length ? ` (${binaryChecks.length} binary checks passed)` : '') +
  `.`
);
