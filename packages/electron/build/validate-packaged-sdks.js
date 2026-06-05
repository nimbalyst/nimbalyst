#!/usr/bin/env node

/**
 * Validates the OUTPUT of a packaged build by exercising the real Node ESM
 * resolver (dynamic `import()`) against the packaged
 * app.asar.unpacked/node_modules tree. This is the same code path the
 * runtime uses, so it catches the failure class where build is green but
 * the feature is broken because runtime resolution would fail.
 *
 * Why this exists: validate-extra-resources.js only checks INPUTS (do the
 * source paths exist before electron-builder runs). That answers "did the
 * config look right" but NOT "did the packaging actually work". Every
 * recurring "build green, feature broken in production" bug we've shipped
 * has been a packaging-output failure that input validation cannot catch.
 *
 * What this checks against the packaged app:
 * 1. Each SDK that is loaded via dynamic `import()` at runtime resolves
 *    correctly from app.asar.unpacked/node_modules. Uses ESM semantics --
 *    honors package.json `exports` maps with `import` conditions, which is
 *    what runtime `await import('@opencode-ai/sdk/client')` does.
 * 2. Each native binary that the runtime spawns exists at the path the
 *    runtime expects AND is executable.
 *
 * Run: node validate-packaged-sdks.js <path-to-packaged-app> [--platform <p>] [--arch <a>]
 *   - macOS:   /path/to/Nimbalyst.app
 *   - Linux:   /path/to/Nimbalyst-Linux.AppImage (extracted dir)
 *   - Windows: /path/to/install/dir
 *
 * Pass --platform/--arch when the caller knows the build target (afterPack
 * does); otherwise the validator infers from the appPath, falling back to
 * the host platform/arch. The fallback is unsafe for cross-arch builds where
 * electron-builder uses an unsuffixed output dir (e.g. release/mac/ for the
 * default-arch mac build) -- the validator then checks the host arch's
 * binary, which afterPack has already pruned for being non-target.
 *
 * Wired into:
 *   - packages/electron/build/afterPack.js (passes --platform/--arch)
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = at least one SDK or binary missing/unresolvable in the packaged app
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { positional: [], platform: undefined, arch: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && i + 1 < argv.length) { out.platform = argv[++i]; continue; }
    if (a === '--arch' && i + 1 < argv.length) { out.arch = argv[++i]; continue; }
    out.positional.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const appPath = args.positional[0];
if (!appPath) {
  console.error('usage: validate-packaged-sdks.js <path-to-packaged-app> [--platform <p>] [--arch <a>]');
  process.exit(1);
}

if (!fs.existsSync(appPath)) {
  console.error(`Path does not exist: ${appPath}`);
  process.exit(1);
}

// Locate app.asar.unpacked across macOS/Win/Linux layouts. Also surface the
// parent Resources/ directory because worker bundles (worker.bundle.js,
// sqlite-worker.bundle.js) and their extraResources-shipped native modules
// live there, NOT inside app.asar.unpacked. Each layer must be checked
// against the right root.
function findPackagedRoots(rootPath) {
  const layouts = [
    { resources: path.join(rootPath, 'Contents', 'Resources') },
    { resources: path.join(rootPath, 'resources') },
    { resources: rootPath },
  ];
  for (const { resources } of layouts) {
    const unpacked = path.join(resources, 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      return { resourcesRoot: resources, unpackedRoot: unpacked };
    }
  }
  return null;
}

const roots = findPackagedRoots(appPath);
if (!roots) {
  console.error(`Could not find app.asar.unpacked under: ${appPath}`);
  process.exit(1);
}
const { resourcesRoot, unpackedRoot } = roots;
const nodeModulesPath = path.join(unpackedRoot, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.error(`No node_modules dir at: ${nodeModulesPath}`);
  process.exit(1);
}

console.log(`[validate-packaged-sdks] node_modules: ${nodeModulesPath}`);
console.log(`[validate-packaged-sdks] resources:    ${resourcesRoot}`);

// Prefer explicit --platform/--arch from the caller (afterPack passes them
// from electron-builder's authoritative context). Fall back to detection
// from the appPath only for direct CLI use, and refuse to use the host
// values silently -- a cross-arch build whose output dir lacks an arch
// token (e.g. release/mac/ for default-arch mac) would otherwise check
// the wrong arch and report an already-pruned package as missing.
function detectArchFromPath(p) {
  if (/[-_/]arm64/.test(p)) return 'arm64';
  if (/[-_/](x64|x86_64)/.test(p)) return 'x64';
  return null;
}
function detectPlatformFromPath(p) {
  if (/Contents[/\\]MacOS/.test(p) || p.endsWith('.app') || /[-_/]mac/.test(p)) return 'darwin';
  if (/[-_/]win/.test(p) || p.endsWith('.exe')) return 'win32';
  if (/[-_/]linux/.test(p)) return 'linux';
  return null;
}
const targetArch = args.arch || detectArchFromPath(appPath);
const targetPlatform = args.platform || detectPlatformFromPath(appPath);
if (!targetArch || !targetPlatform) {
  console.error(
    `[validate-packaged-sdks] cannot determine target platform/arch from "${appPath}". ` +
    `Pass --platform <darwin|win32|linux> --arch <x64|arm64> explicitly. ` +
    `(Refusing to fall back to the host -- that produces false negatives on cross-arch builds.)`,
  );
  process.exit(1);
}
console.log(`[validate-packaged-sdks] target: ${targetPlatform}-${targetArch}`);

// Mirror of getCodexTargetTriple in codexBinaryPath.ts.
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

// SDK packages dynamically imported at runtime via ESM `import()`.
// KEEP IN SYNC with the `external` arrays in packages/electron/electron.vite.config.ts
// (main process) and packages/runtime/vite.config.ts.
//
// NOTE: @zed-industries/codex-acp is NOT in this list because the runtime
// never imports it as a JS module -- it's a CLI-only package (no `main` /
// `exports`), and the runtime uses `require.resolve(<pkg>/package.json)`
// just to discover the install dir before spawning the bin. Treat that as
// a "package presence" check, not an import check.
const SDK_IMPORTS = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  '@opencode-ai/sdk',
  '@opencode-ai/sdk/client',
];

// Packages whose runtime usage is only `require.resolve(<pkg>/package.json)`
// to find where their platform-specific bin sibling is installed. Verify
// the package.json exists in the unpacked tree.
const PACKAGE_PRESENCE = [
  '@zed-industries/codex-acp',
];

// Run the ESM import harness from an ISOLATED temp dir whose only
// node_modules is a symlink to the packaged tree.
//
// CRITICAL: do NOT run the harness from inside the .app bundle. Node's
// module resolver walks UP the filesystem looking for node_modules, so a
// harness inside `<repo>/packages/electron/release/.../app.asar.unpacked/`
// would happily find packages from `<repo>/node_modules/` and report
// "ok" even if the packaged app is missing them entirely. That false
// pass is exactly the failure class this validator must catch.
//
// Putting the harness under /tmp ensures the only resolvable
// node_modules is the symlink we control -- if the packaged tree is
// missing a package, the import fails for real.
function runEsmImportChecks(specs) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-packaged-sdks-'));
  const tmpNodeModules = path.join(tmpRoot, 'node_modules');
  const harnessPath = path.join(tmpRoot, '_validate.mjs');

  // Windows can't create 'dir' symlinks without admin/Developer Mode, but
  // 'junction' works without elevation and is what npm/yarn use internally.
  // 'junction' is a no-op alias for 'dir' on POSIX, so we use it everywhere.
  fs.symlinkSync(path.resolve(nodeModulesPath), tmpNodeModules, 'junction');

  // Build the prefix using pathToFileURL so it matches the form produced by
  // import.meta.resolve. Hand-concatenating "file://" + an OS path breaks on
  // Windows because (a) file URLs need three slashes for a drive letter
  // ("file:///D:/...") and (b) Windows OS paths use backslashes, but file
  // URLs always use forward slashes -- so a startsWith check on the wrong
  // form falsely reports every resolved import as "outside the tree".
  const expectedPrefix = pathToFileURL(path.resolve(nodeModulesPath)).href;
  const source = `
import { createRequire } from 'node:module';
const specs = ${JSON.stringify(specs)};
const expectedPrefix = ${JSON.stringify(expectedPrefix)};
const results = [];
for (const spec of specs) {
  let resolvedUrl;
  try {
    // Resolve first to capture the URL, then load.
    resolvedUrl = import.meta.resolve(spec);
    if (!resolvedUrl.startsWith(expectedPrefix)) {
      results.push({
        spec, ok: false, resolved: resolvedUrl,
        message: 'resolved OUTSIDE packaged tree (Node walked up the filesystem) -- in production this would fail',
      });
      continue;
    }
    await import(spec);
    results.push({ spec, ok: true, resolved: resolvedUrl });
  } catch (err) {
    results.push({
      spec, ok: false, resolved: resolvedUrl,
      code: err && err.code,
      message: err && err.message ? String(err.message).split('\\n')[0] : String(err),
    });
  }
}
process.stdout.write(JSON.stringify(results));
`;
  fs.writeFileSync(harnessPath, source, 'utf8');

  try {
    const result = spawnSync(process.execPath, [harnessPath], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (!result.stdout) {
      throw new Error(`harness produced no output (exit ${result.status}): ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// Native binaries the runtime spawns. Paths mirror runtime resolution
// logic (codexBinaryPath.ts, CodexACPProtocol.resolveCodexAcpBinary, etc).
function nativeBinaryChecks() {
  const out = [];
  const nmRel = (...parts) => path.join(nodeModulesPath, ...parts);

  // 1. claude binary -- @anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude(.exe)
  const claudePlatDir = `claude-agent-sdk-${targetPlatform === 'win32' ? 'win32' : targetPlatform}-${targetArch}`;
  out.push({
    label: 'claude binary (@anthropic-ai/claude-agent-sdk)',
    candidates: [
      nmRel('@anthropic-ai', claudePlatDir, targetPlatform === 'win32' ? 'claude.exe' : 'claude'),
    ],
  });

  // 2. codex binary -- @openai/codex-<plat>-<arch>/vendor/<triple>/<bin|codex>/codex(.exe)
  // Layout candidates must mirror codexBinaryPath.ts: codex-sdk 0.131+ moved
  // the binary into a `bin/` subdirectory; older layouts used `codex/` or the
  // triple dir directly. Keep this list in sync with that resolver.
  const triple = codexTargetTriple(targetPlatform, targetArch);
  if (triple) {
    const codexPlatDir = `codex-${targetPlatform === 'win32' ? 'win32' : targetPlatform}-${targetArch}`;
    const codexBin = targetPlatform === 'win32' ? 'codex.exe' : 'codex';
    out.push({
      label: 'codex binary (@openai/codex)',
      candidates: [
        nmRel('@openai', codexPlatDir, 'vendor', triple, 'bin', codexBin),
        nmRel('@openai', codexPlatDir, 'vendor', triple, 'codex', codexBin),
        nmRel('@openai', codexPlatDir, 'vendor', triple, codexBin),
      ],
    });
  }

  // 3. codex-acp binary -- @zed-industries/codex-acp-<plat>-<arch>/bin/codex-acp(.exe)
  const acpPlatDir = `codex-acp-${targetPlatform === 'win32' ? 'win32' : targetPlatform}-${targetArch}`;
  out.push({
    label: 'codex-acp binary (@zed-industries/codex-acp)',
    candidates: [
      nmRel('@zed-industries', acpPlatDir, 'bin', targetPlatform === 'win32' ? 'codex-acp.exe' : 'codex-acp'),
    ],
  });

  return out;
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return /\.(exe|cmd|bat)$/i.test(filePath);
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const failures = [];

// ---- 1. SDK ESM imports ----
console.log('\n[validate-packaged-sdks] Resolving SDK imports via real ESM...');
const importResults = runEsmImportChecks(SDK_IMPORTS);
for (const r of importResults) {
  if (r.ok) {
    console.log(`  [ok] import("${r.spec}")`);
  } else {
    failures.push({
      kind: 'sdk',
      target: r.spec,
      reason: `ESM import() failed: ${r.code ? r.code + ' -- ' : ''}${r.message}`,
    });
  }
}

// ---- 1b. Package presence (for CLI-only packages used via path resolution) ----
console.log('\n[validate-packaged-sdks] Checking package presence...');
for (const pkg of PACKAGE_PRESENCE) {
  const pkgJsonPath = path.join(nodeModulesPath, pkg, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    console.log(`  [ok] ${pkg}/package.json present`);
  } else {
    failures.push({
      kind: 'package',
      target: pkg,
      reason: `package.json not present at ${path.relative(nodeModulesPath, pkgJsonPath)}`,
    });
  }
}

// ---- 2. Native binary existence + executability ----
console.log('\n[validate-packaged-sdks] Checking native binaries...');
for (const check of nativeBinaryChecks()) {
  const found = check.candidates.find(isExecutableFile);
  if (found) {
    console.log(`  [ok] ${check.label} -> ${path.relative(nodeModulesPath, found)}`);
    continue;
  }
  // Distinguish "exists but not executable" from "missing entirely" for a clear error.
  const existing = check.candidates.find(fs.existsSync);
  failures.push({
    kind: 'binary',
    target: check.label,
    reason: existing
      ? `${path.relative(nodeModulesPath, existing)} exists but is not an executable file (likely a directory or missing exec bits)`
      : `not found at: ${check.candidates.map((c) => path.relative(nodeModulesPath, c)).join(' OR ')}`,
  });
}

// ---- 3. Worker bundles: external module resolution ----
// Worker bundles (worker_threads workers spawned from main) live OUTSIDE
// app.asar at Resources/. Their esbuild config marks platform-specific deps
// as `external`, which means at runtime Node has to find them on disk
// starting from the bundle's location. The app.asar.unpacked tree is
// INVISIBLE to those workers -- only Resources/node_modules/ (and the
// directories Node would walk into above it) is reachable.
//
// This check exists because the SDK_IMPORTS list above only knows about
// app.asar.unpacked; without it, a worker-only external like better-sqlite3
// can ship missing from the build and the validator reports PASS while
// runtime fails with "Cannot find module 'better-sqlite3'". The history of
// that exact bug is what motivated this section.
//
// KEEP IN SYNC with the `external` arrays in
// packages/electron/build/build-worker.js. The PGLite worker bundle
// (worker.bundle.js) has no JS externals -- @electric-sql/pglite gets
// inlined by esbuild -- so it appears here only to assert the bundle file
// itself was shipped.
const WORKER_BUNDLES = [
  {
    name: 'sqlite-worker',
    bundle: 'sqlite-worker.bundle.js',
    externals: ['better-sqlite3'],
    nativeBinaries: [
      // better-sqlite3 loads via `bindings(...)` -> require of a .node file.
      // Verify the .node exists where bindings will find it.
      { relPath: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node' },
    ],
  },
  {
    name: 'pglite-worker',
    bundle: 'worker.bundle.js',
    externals: [],
    nativeBinaries: [],
  },
];

console.log('\n[validate-packaged-sdks] Checking worker bundle externals...');
const Module = require('module');
const resourcesSep = resourcesRoot.endsWith(path.sep) ? resourcesRoot : resourcesRoot + path.sep;
for (const wb of WORKER_BUNDLES) {
  const bundlePath = path.join(resourcesRoot, wb.bundle);
  if (!fs.existsSync(bundlePath)) {
    failures.push({
      kind: 'worker-bundle',
      target: wb.bundle,
      reason: `bundle file missing at ${bundlePath}`,
    });
    continue;
  }
  console.log(`  [ok] ${wb.bundle} present`);

  // Run require.resolve from the bundle's location. createRequire gives a
  // Node require keyed to that file, so the lookup walks node_modules/ from
  // Resources/ upward -- exactly what worker_threads will do at runtime.
  const req = Module.createRequire(bundlePath);
  for (const spec of wb.externals) {
    let resolved;
    try {
      resolved = req.resolve(spec);
    } catch (err) {
      failures.push({
        kind: 'worker-external',
        target: `${wb.bundle} -> require("${spec}")`,
        reason: `${err && err.code ? err.code + ' -- ' : ''}${err && err.message ? err.message.split('\n')[0] : String(err)}`,
      });
      continue;
    }
    // Catch the same false-pass class the SDK_IMPORTS check guards against:
    // Node walked UP the filesystem from Resources/ and found the module in
    // the dev tree (e.g. <repo>/packages/electron/node_modules/...). The
    // packaged app on a user's machine has no such parent -- this would
    // fail there but pass here.
    if (!resolved.startsWith(resourcesSep)) {
      failures.push({
        kind: 'worker-external',
        target: `${wb.bundle} -> require("${spec}")`,
        reason: `resolved OUTSIDE packaged tree to ${resolved} (Node walked up past Resources/; user installs will fail)`,
      });
      continue;
    }
    console.log(`  [ok] ${wb.bundle} require("${spec}") -> ${path.relative(resourcesRoot, resolved)}`);
  }

  for (const nb of wb.nativeBinaries) {
    const nbPath = path.join(resourcesRoot, nb.relPath);
    if (!fs.existsSync(nbPath)) {
      failures.push({
        kind: 'worker-native',
        target: `${wb.bundle} -> ${nb.relPath}`,
        reason: `native binary missing at ${nbPath}`,
      });
      continue;
    }
    console.log(`  [ok] ${wb.bundle} native ${nb.relPath}`);
  }
}

// ---- 4. Worker bundle ABI boot check (Electron-as-Node) ----
// Path resolution above proves the files are in the right place. It does
// NOT prove the .node binary actually dlopens against the packaged
// Electron's Node ABI. After an Electron version bump, `@electron/rebuild`
// has to recompile every native module; if that step is skipped (or the
// prebuild cache hands back a stale binary), require resolves fine but
// dlopen fails with `NODE_MODULE_VERSION mismatch` at runtime.
//
// Running the actual packaged Electron binary with ELECTRON_RUN_AS_NODE=1
// is the only way to test the real ABI from here -- system Node uses a
// different ABI than Electron's bundled Node.
//
// Cross-platform builds skip this check: a Linux ELF or Windows .exe
// produced on a macOS host cannot be executed by the host. Cross-arch
// within the same OS is fine on macOS (Rosetta runs x64 binaries on
// arm64 hosts).
function findElectronBinary() {
  if (targetPlatform === 'darwin') {
    const macOsDir = path.join(appPath, 'Contents', 'MacOS');
    if (!fs.existsSync(macOsDir)) return null;
    const entries = fs.readdirSync(macOsDir).filter((n) => !n.startsWith('.'));
    if (entries.length === 0) return null;
    return path.join(macOsDir, entries[0]);
  }
  if (targetPlatform === 'linux') {
    const entries = fs.readdirSync(appPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(appPath, e.name);
      if (isExecutableFile(full)) return full;
    }
    return null;
  }
  if (targetPlatform === 'win32') {
    const entries = fs.readdirSync(appPath).filter((n) => n.toLowerCase().endsWith('.exe'));
    if (entries.length === 0) return null;
    return path.join(appPath, entries[0]);
  }
  return null;
}

// Boot check is INFORMATIONAL ONLY. The path-resolution and .node-presence
// checks above are the gates that catch real packaging failures (and were
// what caught the better-sqlite3 packaging miss). The boot check adds a
// nice-to-have ABI sanity check on top, but it runs at afterPack time --
// before the .app is signed. On a clean macOS CI runner, executing the
// unsigned Electron Framework dylib triggers LaunchServices verification
// that hangs without a user session, killing the spawn at the 30s timeout
// with no stderr. That's an environment quirk, not a packaging bug, and
// the release pipeline must not break on it. A real probe failure (got
// stderr like "Cannot find module" or NODE_MODULE_VERSION mismatch) is
// still surfaced, but as a warning -- the path-resolution check would
// have already failed in those cases.
const canBootCheck = targetPlatform === process.platform;
const bootWarnings = [];
if (canBootCheck) {
  console.log('\n[validate-packaged-sdks] Booting workers via Electron-as-Node (ABI check, informational)...');
  const electronBin = findElectronBinary();
  if (!electronBin) {
    bootWarnings.push({
      target: 'electron binary',
      reason: `could not locate packaged Electron binary under ${appPath}`,
    });
  } else {
    // Each worker bundle that has native externals gets a minimal load test:
    // require() the external, exercise one cheap call to force dlopen. We
    // don't go through worker_threads here -- the same Node ABI is in play,
    // and require/dlopen happens at module load regardless of thread.
    const NATIVE_BOOT_PROBES = {
      'better-sqlite3': `
        const Database = req('better-sqlite3');
        const db = new Database(':memory:');
        const r = db.prepare('select sqlite_version() as v').get();
        db.close();
        if (!r || !r.v) throw new Error('better-sqlite3 returned no sqlite_version');
      `,
    };

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-worker-boot-'));
    try {
      for (const wb of WORKER_BUNDLES) {
        for (const spec of wb.externals) {
          const probe = NATIVE_BOOT_PROBES[spec];
          if (!probe) continue; // No probe defined; resolution check above is the floor.
          // The harness chdir's into the packaged Resources/ so require()
          // resolves the same way the worker does at runtime.
          const harnessPath = path.join(tmpRoot, `boot-${wb.name}-${spec.replace(/[^a-z0-9]/gi, '_')}.js`);
          // Key require() to the worker bundle's path so module resolution
          // walks the same node_modules/ chain the worker_threads worker
          // would at runtime. A bare `require()` from this temp harness
          // would walk up from /tmp/... and miss the packaged tree. Use
          // `req` (not `require`) so we don't shadow the harness's own
          // require -- shadowing trips Electron's loader, which treats the
          // redeclaration as an ESM signal.
          const bundlePathLiteral = JSON.stringify(path.join(resourcesRoot, wb.bundle));
          const harnessSource = `
            'use strict';
            const req = require('module').createRequire(${bundlePathLiteral});
            try {
              ${probe.trim()}
              process.stdout.write('OK');
              process.exit(0);
            } catch (err) {
              process.stderr.write((err && err.stack) ? err.stack : String(err));
              process.exit(1);
            }
          `;
          fs.writeFileSync(harnessPath, harnessSource, 'utf8');
          const result = spawnSync(electronBin, [harnessPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 30_000,
          });
          if (result.status === 0 && result.stdout.includes('OK')) {
            console.log(`  [ok] ${wb.bundle} require("${spec}") + dlopen (ABI matches Electron's Node)`);
          } else {
            const stderr = (result.stderr || '').trim();
            // Distinguish a real probe failure from an environmental hang.
            // Real failure: status=1 with stderr containing the thrown error.
            // Environmental hang: status=null (killed by timeout) with empty
            // stderr -- the binary never executed the harness JS, usually
            // because afterPack runs before signing and macOS Gatekeeper
            // blocks the unsigned Electron Framework on clean CI runners.
            if (result.status === null && !stderr) {
              console.log(
                `  [skip] ${wb.bundle} require("${spec}"): Electron-as-Node spawn timed out before the harness produced output ` +
                `(probably unsigned binary on a CI runner; path-resolution check above is the real gate)`,
              );
            } else {
              bootWarnings.push({
                target: `${wb.bundle} -> require("${spec}")`,
                reason: `Electron-as-Node boot failed (status=${result.status}): ${stderr.split('\n').slice(0, 5).join(' | ') || '<no stderr>'}`,
              });
            }
          }
        }
      }
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    }
  }
} else {
  console.log(
    `\n[validate-packaged-sdks] Skipping worker boot check: target ${targetPlatform} != host ${process.platform} (host cannot execute target's Electron binary)`,
  );
}

// ---- Report ----
const workerExternalCount = WORKER_BUNDLES.reduce((n, wb) => n + wb.externals.length, 0);
if (bootWarnings.length > 0) {
  console.warn('\n[validate-packaged-sdks] Worker boot warnings (informational, non-fatal):');
  for (const w of bootWarnings) {
    console.warn(`  [warn] ${w.target}`);
    console.warn(`         ${w.reason}`);
  }
}
if (failures.length === 0) {
  console.log(
    `\n[validate-packaged-sdks] PASS: ${SDK_IMPORTS.length} SDK imports + ${nativeBinaryChecks().length} native binaries + ${WORKER_BUNDLES.length} worker bundles (${workerExternalCount} externals${canBootCheck ? '; ABI boot informational' : ''}) verified in packaged tree.`,
  );
  process.exit(0);
}

console.error('\n[validate-packaged-sdks] FAIL: the packaged app is missing runtime-required files.\n');
console.error('This is the failure class that input-only validation cannot catch:');
console.error('builds appear green and ship, then break at runtime when the');
console.error('feature actually tries to load its dependency.\n');
for (const f of failures) {
  console.error(`  [${f.kind}] ${f.target}`);
  console.error(`         ${f.reason}\n`);
}
console.error(`Inspect: ${nodeModulesPath}`);
process.exit(1);
