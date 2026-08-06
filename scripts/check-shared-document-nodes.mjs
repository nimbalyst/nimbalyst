#!/usr/bin/env node
/**
 * Guards the reference-node contract shared by every host that can open a
 * Nimbalyst shared document.
 *
 * A Lexical node type that one host persists into a shared Y.Doc must be
 * registered by every other host that opens that Y.Doc. A host that mounts the
 * collaborative editor without the node class does not merely lose a chip:
 * `@lexical/yjs` throws ``Node <type> is not registered`` from inside the
 * observer that `Y.applyUpdate` fires, the binding aborts, and NOTHING paints.
 *
 * That is how the web console broke on 2026-08-03. `packages/collab-bundle`
 * registered neither `tracker-reference` nor `document-reference` -- both were
 * registered only by electron-renderer plugins -- so any desktop-authored
 * document containing one failed to open. It surfaced misleadingly as
 * `[DocumentSync] Skipping undecodable update`: the payload had decrypted fine,
 * the Lexical binding threw. The fix (60c471b) moved the registration into the
 * shared `referenceNodeContributions.ts` so the hosts cannot drift again. This
 * gate is what makes "cannot drift again" true.
 *
 * How it measures, and what that buys:
 *   The contract is not a hardcoded list of type names. The gate esbuild-bundles
 *   a probe per host, imports it, and reads the node types the host's own
 *   registration path actually produces -- the same modules, the same stores,
 *   the same `Klass.getType()` the editor reads. The required set is whatever
 *   `registerReferenceNodeContributions()` publishes, so adding a third
 *   reference node raises the bar for every host automatically.
 *
 * Each host is also checked for WIRING: registering in a module nobody imports
 * is the same outage. The host's real entry file must import (and, where the
 * registration is a function, call) the registration. That check is a
 * single-file AST read, so it does not follow re-exports or indirection -- see
 * the blind spots below.
 *
 * What this CANNOT catch:
 *   - Hosts it has not been told about. `HOSTS` is a declared list; a fourth
 *     shared-document host added tomorrow is invisible here until it is added.
 *     `packages/ios/src/editor-mobile` is deliberately absent: it mounts no
 *     collab provider today and edits local markdown only.
 *   - Drift inside the built-in extension graph. Desktop and collab-bundle
 *     compose the same `buildNimbalystRootExtension`, so the built-in half is
 *     shared code rather than two lists; only the extension-store half (where
 *     the outage happened) is compared. A host that forked that graph and
 *     dropped, say, `MermaidNode` would pass this gate.
 *   - `HeadlessBodyNodes` vs. the renderer graph. The headless list is compared
 *     against the reference-node contract only. It intentionally omits nodes
 *     with no markdown syntax (kanban, collapsible, layout), so a full superset
 *     comparison would be wrong, not merely expensive.
 *   - Wiring reached indirectly. If a host's entry moves the registration behind
 *     a re-export, a dynamic import, or a conditional, the wiring check fails
 *     loudly (missing import / missing call) rather than silently passing. That
 *     is the intended failure direction: update `HOSTS`.
 *   - Runtime ordering. The gate proves the types are registered, not that they
 *     are registered before the editor mounts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, '..');

/** Where `registerReferenceNodeContributions()` lives; the source of the required set. */
export const CONTRACT = {
  id: 'shared-contract',
  label: 'shared reference-node contributions',
  module: 'packages/runtime/src/plugins/referenceNodeContributions.ts',
  probe: {
    kind: 'extension-store',
    imports: [
      {
        from: 'packages/runtime/src/plugins/referenceNodeContributions.ts',
        names: ['registerReferenceNodeContributions'],
      },
    ],
    calls: ['registerReferenceNodeContributions'],
  },
};

/**
 * Every host that can open a shared document, with the registration path it
 * really uses and the entry file that has to reach that path.
 */
export const HOSTS = [
  {
    id: 'desktop-renderer',
    label: 'Electron renderer (desktop app)',
    probe: {
      kind: 'extension-store',
      imports: [
        {
          from: 'packages/electron/src/renderer/plugins/registerTrackerLinkPlugin.tsx',
          names: ['registerTrackerLinkPlugin'],
        },
        {
          from: 'packages/electron/src/renderer/plugins/registerDocumentLinkPlugin.tsx',
          names: ['registerDocumentLinkPlugin'],
        },
      ],
      calls: ['registerTrackerLinkPlugin', 'registerDocumentLinkPlugin'],
    },
    entry: 'packages/electron/src/renderer/App.tsx',
    wiring: [
      { symbol: 'registerTrackerLinkPlugin', call: true },
      { symbol: 'registerDocumentLinkPlugin', call: true },
    ],
    fix: 'packages/electron/src/renderer/plugins/registerTrackerLinkPlugin.tsx'
      + ' / registerDocumentLinkPlugin.tsx',
  },
  {
    id: 'collab-bundle',
    label: 'collab bundle (web console and WebView hosts)',
    // Registration is an exported function, not a module side effect: this
    // package marks its own `.ts` files side-effect-free, so a bare import with
    // no used bindings is legal for the bundler to delete -- and Rolldown did
    // delete it (d14e218c). The probe has to call it the way the entry does.
    probe: {
      kind: 'extension-store',
      imports: [{
        from: 'packages/collab-bundle/src/editor/referenceNodes.ts',
        names: ['registerBrowserReferenceNodes'],
      }],
      calls: ['registerBrowserReferenceNodes'],
    },
    entry: 'packages/collab-bundle/src/editor/mount.tsx',
    wiring: [{ symbol: 'registerBrowserReferenceNodes', call: true }],
    fix: 'packages/collab-bundle/src/editor/referenceNodes.ts',
  },
  {
    id: 'main-process-headless',
    label: 'headless main-process seeder',
    probe: {
      kind: 'node-array',
      from: 'packages/runtime/src/editor/nodes/headlessBodyNodes.ts',
    },
    entry: 'packages/runtime/src/sync/MarkdownCollabContentAdapter.ts',
    wiring: [{ symbol: 'HeadlessBodyNodes' }],
    fix: 'packages/runtime/src/editor/nodes/headlessBodyNodes.ts',
  },
];

/**
 * Modules replaced with an empty stub inside a probe bundle. Each must be
 * incapable of contributing a Lexical node: these are DOM-only leaves that a
 * host's registration graph drags in and that throw at import time under Node.
 * A module that needs stubbing and is not listed here fails the gate loudly.
 */
export const STUBBED_MODULES = [
  // monaco-editor touches `window` at module scope; it ships the code editor,
  // never a Lexical node.
  'monaco-editor',
];

const EXTENSION_STORE = 'packages/runtime/src/editor/extensions/extensionLexicalExtensionsStore.ts';

/** Bundler aliases the hosts' own bundlers apply (see collab-bundle/vite.config.ts). */
const WORKSPACE_ALIASES = [
  { prefix: '@nimbalyst/runtime/', target: 'packages/runtime/src/' },
  { prefix: '@nimbalyst/collab-client/', target: 'packages/collab-client/src/' },
];

function abs(repoRoot, relative) {
  return path.isAbsolute(relative) ? relative : path.join(repoRoot, relative);
}

/**
 * Read a node type the way Lexical does. An extension's `nodes` entry is either
 * a node class or a `{ replace, with }` override record.
 */
const NODE_TYPE_READER = `
function nimNodeType(node) {
  if (node && typeof node.getType === 'function') return node.getType();
  if (node && node.replace && typeof node.replace.getType === 'function') {
    return node.replace.getType();
  }
  return null;
}
`;

/** Probe source: a module exporting `readNodeTypes()`. */
export function buildProbeSource(probe, repoRoot) {
  const q = (relative) => JSON.stringify(abs(repoRoot, relative));

  if (probe.kind === 'node-array') {
    return `${NODE_TYPE_READER}
import NIM_NODES from ${q(probe.from)};
export function readNodeTypes() {
  return NIM_NODES.map(nimNodeType).filter((type) => type !== null);
}
`;
  }

  if (probe.kind === 'extension-store') {
    const imports = probe.imports.map((entry) => (
      entry.names?.length
        ? `import { ${entry.names.join(', ')} } from ${q(entry.from)};`
        : `import ${q(entry.from)};`
    ));
    const calls = (probe.calls ?? []).map((name) => `${name}();`);
    return `${NODE_TYPE_READER}
${imports.join('\n')}
import { getExtensionLexicalExtensions } from ${q(EXTENSION_STORE)};
${calls.join('\n')}
export function readNodeTypes() {
  const types = [];
  for (const extension of getExtensionLexicalExtensions()) {
    for (const node of (extension?.nodes ?? [])) {
      const type = nimNodeType(node);
      if (type !== null) types.push(type);
    }
  }
  return types;
}
`;
  }

  throw new Error(`Unknown probe kind: ${probe.kind}`);
}

/** Empty-module stubs plus Vite's `?raw` suffix, which esbuild does not know. */
function probePlugins(stubs) {
  const stubFilter = stubs.length > 0
    ? new RegExp(`^(?:${stubs.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:/|$)`)
    : null;
  return [{
    name: 'nimbalyst-probe-resolvers',
    setup(build) {
      if (stubFilter) {
        build.onResolve({ filter: stubFilter }, (args) => (
          { path: args.path, namespace: 'nim-stub' }
        ));
        build.onLoad({ filter: /.*/, namespace: 'nim-stub' }, () => (
          { contents: 'export default {};', loader: 'js' }
        ));
      }
      build.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
        namespace: 'nim-raw',
      }));
      build.onLoad({ filter: /.*/, namespace: 'nim-raw' }, (args) => (
        { contents: readFileSync(args.path, 'utf8'), loader: 'text' }
      ));
    },
  }];
}

/**
 * Bundle a probe and run it, returning the node types it registered.
 *
 * Each probe is a standalone bundle, so the extension store inside it is a fresh
 * module instance: hosts cannot contaminate each other's measurement.
 */
export async function collectNodeTypes(probe, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const stubs = options.stubs ?? STUBBED_MODULES;
  const outDir = mkdtempSync(path.join(tmpdir(), 'nim-node-probe-'));
  const entry = path.join(outDir, 'probe.ts');
  const outfile = path.join(outDir, 'probe.mjs');
  try {
    writeFileSync(entry, buildProbeSource(probe, repoRoot), 'utf8');
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      absWorkingDir: repoRoot,
      bundle: true,
      platform: 'node',
      format: 'esm',
      jsx: 'automatic',
      logLevel: 'silent',
      // A host may mark its registration side-effect-free for tree shaking; the
      // probe imports it precisely for that side effect.
      ignoreAnnotations: true,
      // The hosts build through Vite, which supplies `import.meta.env`. Without
      // it, first-party modules that branch on DEV throw at import time.
      define: {
        'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production' }),
      },
      alias: Object.fromEntries(WORKSPACE_ALIASES.map(({ prefix, target }) => [
        prefix.replace(/\/$/, ''),
        abs(repoRoot, target.replace(/\/$/, '')),
      ])),
      loader: {
        '.css': 'empty',
        '.svg': 'empty',
        '.png': 'empty',
        '.jpg': 'empty',
        '.gif': 'empty',
        '.woff': 'empty',
        '.woff2': 'empty',
        '.yaml': 'text',
        '.yml': 'text',
      },
      // Bundled CommonJS dependencies call `require` at import time; ESM output
      // has none unless it is handed one.
      banner: {
        js: "import { createRequire as __nimCreateRequire } from 'node:module';\n"
          + 'const require = __nimCreateRequire(import.meta.url);',
      },
      plugins: probePlugins(stubs),
    });
    const module = await import(pathToFileURL(outfile).href);
    return module.readNodeTypes();
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function resolveSpecifier(specifier, fromFile, repoRoot) {
  let base = null;
  if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    const alias = WORKSPACE_ALIASES.find((entry) => specifier.startsWith(entry.prefix));
    if (alias) {
      base = abs(repoRoot, alias.target + specifier.slice(alias.prefix.length));
    }
  }
  if (base === null) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

/** Imports and top-level call targets of a single entry file. */
export function readEntryWiring(entryFile, repoRoot = REPO_ROOT) {
  const text = readFileSync(entryFile, 'utf8');
  const sourceFile = ts.createSourceFile(entryFile, text, ts.ScriptTarget.Latest, true);
  const modules = new Set();
  const symbols = new Set();
  const calls = new Set();

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveSpecifier(node.moduleSpecifier.text, entryFile, repoRoot);
      if (resolved) modules.add(resolved);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) symbols.add(element.name.text);
      }
      if (node.importClause?.name) symbols.add(node.importClause.name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { modules, symbols, calls };
}

/** Violations for hosts whose entry no longer reaches its registration. */
export function findWiringViolations(hosts = HOSTS, repoRoot = REPO_ROOT) {
  const violations = [];
  for (const host of hosts) {
    if (!host.entry || !host.wiring?.length) continue;
    const entryFile = abs(repoRoot, host.entry);
    let wiring;
    try {
      wiring = readEntryWiring(entryFile, repoRoot);
    } catch (error) {
      violations.push({
        kind: 'entry-unreadable',
        host: host.id,
        entry: host.entry,
        fix: host.fix,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const requirement of host.wiring) {
      if (requirement.module) {
        const target = abs(repoRoot, requirement.module);
        if (!wiring.modules.has(target)) {
          violations.push({
            kind: 'missing-import',
            host: host.id,
            entry: host.entry,
            target: requirement.module,
            fix: host.fix,
          });
        }
        continue;
      }
      if (!wiring.symbols.has(requirement.symbol)) {
        violations.push({
          kind: 'missing-import',
          host: host.id,
          entry: host.entry,
          target: requirement.symbol,
          fix: host.fix,
        });
        continue;
      }
      if (requirement.call && !wiring.calls.has(requirement.symbol)) {
        violations.push({
          kind: 'missing-call',
          host: host.id,
          entry: host.entry,
          target: requirement.symbol,
          fix: host.fix,
        });
      }
    }
  }
  return violations;
}

/**
 * Compare each host's measured node types against the contract.
 *
 * `hostTypes` maps host id -> string[]. A host absent from the map is a probe
 * that never ran, which is a failure and never a pass.
 */
export function compareNodeTypes(contractTypes, hostTypes, hosts = HOSTS) {
  const violations = [];
  const required = [...new Set(contractTypes ?? [])];
  if (required.length === 0) {
    violations.push({ kind: 'empty-contract' });
    return violations;
  }
  for (const host of hosts) {
    const measured = hostTypes.get(host.id);
    if (!measured) {
      violations.push({ kind: 'probe-missing', host: host.id, fix: host.fix });
      continue;
    }
    const registered = new Set(measured);
    for (const type of required) {
      if (!registered.has(type)) {
        violations.push({ kind: 'missing-node-type', host: host.id, type, fix: host.fix });
      }
    }
  }
  return violations;
}

export async function findSharedDocumentNodeDrift(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const hosts = options.hosts ?? HOSTS;
  const contract = options.contract ?? CONTRACT;
  const violations = [];

  let contractTypes = [];
  try {
    contractTypes = await collectNodeTypes(contract.probe, { repoRoot, ...options.probeOptions });
  } catch (error) {
    return [{
      kind: 'probe-failed',
      host: contract.id,
      fix: contract.module,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }

  const hostTypes = new Map();
  for (const host of hosts) {
    try {
      hostTypes.set(host.id, await collectNodeTypes(host.probe, { repoRoot, ...options.probeOptions }));
    } catch (error) {
      violations.push({
        kind: 'probe-failed',
        host: host.id,
        fix: host.fix,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  violations.push(...compareNodeTypes(contractTypes, hostTypes, hosts));
  violations.push(...findWiringViolations(hosts, repoRoot));
  return violations;
}

export function formatViolations(violations, hosts = HOSTS) {
  const label = (id) => hosts.find((host) => host.id === id)?.label ?? id;
  const lines = violations.map((violation) => {
    switch (violation.kind) {
      case 'empty-contract':
        return '  + registerReferenceNodeContributions() registered no node types at all.\n'
          + `    Restore them in ${CONTRACT.module}; with an empty contract this gate proves nothing.`;
      case 'missing-node-type':
        return `  + ${label(violation.host)} does not register the node type "${violation.type}".\n`
          + `    A shared document containing it will fail to open on this host.\n`
          + `    Fix in ${violation.fix}; the required set comes from ${CONTRACT.module}.`;
      case 'probe-missing':
      case 'probe-failed':
        return `  + could not measure the node types registered by ${label(violation.host)}.\n`
          + `    ${violation.detail ?? 'the probe produced no result'}\n`
          + `    Check ${violation.fix}; an unmeasurable host is treated as a failure.`;
      case 'missing-import':
        return `  + ${label(violation.host)} entry ${violation.entry} no longer imports `
          + `${violation.target}.\n`
          + `    Registering in a module nobody imports is the same outage as not registering.\n`
          + `    Fix in ${violation.entry} (registration lives in ${violation.fix}).`;
      case 'missing-call':
        return `  + ${label(violation.host)} entry ${violation.entry} imports ${violation.target} `
          + 'but never calls it.\n'
          + `    Fix in ${violation.entry} (registration lives in ${violation.fix}).`;
      case 'entry-unreadable':
        return `  + ${label(violation.host)} entry ${violation.entry} could not be read: `
          + `${violation.detail}\n`
          + '    If the host moved, update HOSTS in scripts/check-shared-document-nodes.mjs.';
      default:
        return `  + ${JSON.stringify(violation)}`;
    }
  });
  return 'every host that opens a shared document must register the same reference nodes:\n'
    + lines.join('\n')
    + '\nA missing node class makes @lexical/yjs throw "Node <type> is not registered" inside\n'
    + 'the Y.applyUpdate observer, which aborts the binding so the document never paints.';
}

export async function checkSharedDocumentNodes(options = {}) {
  const violations = await findSharedDocumentNodeDrift(options);
  if (violations.length > 0) {
    throw new Error(formatViolations(violations, options.hosts ?? HOSTS));
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkSharedDocumentNodes();
    console.log(
      `[shared-document-nodes] ${HOSTS.length} shared-document hosts register the same reference nodes.`,
    );
  } catch (error) {
    console.error(`[shared-document-nodes] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
