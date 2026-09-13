#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  findBrowserDependencyViolations,
  normalizeBrowserModuleId,
} from './browser-bundle-graph.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const packageRoot = path.join(repoRoot, 'packages/collab-bundle');
const distRoot = path.join(packageRoot, 'dist');
const reportPath = path.join(distRoot, 'bundle-report.json');

// Initial eager measurements were 253,357 gzip bytes for editor. The migrated
// docs-ui shell initially measured 55,405 gzip bytes; feedback-ui measured
// 27,754 gzip bytes; the inbox transport measured 4,586 gzip bytes. Their
// ceilings leave ~26% headroom so shell growth is a conscious review decision.
export const COLLAB_BUNDLE_EAGER_GZIP_BUDGET_BYTES = {
  // The comment panel/composer/mention primitives a browser extension host
  // hands to a pinned extension, and nothing else. If this jumps, the comment
  // UI has grown an editor or transport dependency it should not have.
  // Initially 29,203 gzip bytes; same ~26% headroom as the shells above.
  'commenting-ui': 37_000,
  // Project Canvas: React Flow, the card tree, the binding, and the SDK's
  // collaborative-editor hook. Measured at 94,278 gzip bytes on first build;
  // same ~26% headroom as the shells above. This entry is never eager in a
  // host -- the console imports it only when a board opens -- so the ceiling
  // is about the board's own cost, not the console's first paint.
  canvas: 118_000,
  editor: 320_000,
  // Measured at 70,625 gzip bytes on 2026-09-08, when the list took over
  // folder browsing from the tree for the browser console (folder rows, the
  // browse scope, the row "more" action). The row context menu itself is
  // lazy-loaded from the list and is not in this graph; a static import of
  // `SharedDocsItemMenu` is what would push this over again.
  'docs-ui': 74_000,
  // Sep 5 privacy-aware document transport graph measured 35,049 bytes.
  // Keep a narrow allowance for the supported response/refresh contract.
  'feedback-ui': 35_500,
  // The tracker surfaces plus the headless selectors and the in-page engine
  // they read through. Measured at 100,654 gzip bytes on first build; the
  // ceiling carries the same ~26% headroom as the shells above.
  //
  // It is the largest non-editor entry and legitimately so: RevoGrid's column
  // and cell-editor layer, the tracker schema model, and `TrackerSyncEngine`
  // (with `OutboxDrainer`, which brings js-yaml) are all eager here. The grid
  // alone is several times `docs-ui`'s remaining headroom, which is why this is
  // a separate entry rather than a line item added there.
  'trackers-ui': 128_000,
  // Deliberately tight. This entry is a WebSocket client over the protocol
  // package and nothing else; anything that makes it jump has dragged a UI
  // graph in behind it.
  inbox: 6_000,
};

const builtinNames = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]),
);

export const COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES = [
  {
    name: 'Electron',
    test: (id) => id === 'electron'
      || id.startsWith('electron/')
      || id.includes('/packages/electron/')
      || id.includes('/node_modules/electron/'),
  },
  {
    name: 'Node builtins',
    test: (id) => id.startsWith('node:') || builtinNames.has(id),
  },
  {
    name: 'filesystem',
    test: (id) => id === 'fs'
      || id === 'fs/promises'
      || id === 'path'
      || id.includes('/runtime/src/editor/utils/assetPaths.')
      || /(^|\/)node_modules\/(?:graceful-fs|memfs)(?:\/|$)/.test(id),
  },
  {
    name: 'secrets-bearing modules',
    test: (id) => id.includes('/runtime/src/ai/server/')
      || id.includes('/runtime/src/electron/')
      || /\/(?:kms|keychain|secret-store|credentials)(?:\/|\.)/i.test(id),
  },
  {
    // DraggableBlockPlugin is intentionally absent: the block handle is a
    // pointer affordance the browser host shares with desktop, not a
    // desktop-only surface. See packages/collab-bundle/vite.config.ts.
    name: 'desktop-only editor plugins',
    test: (id) => /\/runtime\/src\/editor\/plugins\/(?:DiffPlugin\/index\.tsx|SpeechToTextPlugin\/index\.ts)$/.test(id),
  },
  {
    name: 'extension SDK leakage',
    test: (id) => id === '@nimbalyst/extension-sdk'
      || id.startsWith('@nimbalyst/extension-sdk/')
      || id.includes('/packages/extension-sdk/')
      || id.includes('/node_modules/@nimbalyst/extension-sdk/'),
  },
];

/**
 * Entries allowed to carry the extension SDK's runtime, and why.
 *
 * The SDK rule exists so the shells cannot quietly become an SDK
 * re-distributor: `./editor`, `./docs-ui` and `./trackers-ui` implement the
 * `EditorHost` contract natively (`browserExtensionHost`,
 * `createBrowserCollaborationContext`) and a pinned extension brings its own
 * SDK copy, so an SDK module appearing in those graphs means someone imported
 * the implementation where the contract was meant to be.
 *
 * `./canvas` is on the other side of that contract. Project Canvas is an
 * `EditorHostProps` editor exactly like a pinned extension is -- it consumes
 * the SDK's `useCollaborativeEditor` rather than implementing a second one --
 * and the console mounts it through the same `mountExtensionEditor` path. The
 * copy is confined to the lazily-imported canvas chunk, and `COLLAB_INIT_ORIGIN`
 * (a `Symbol`, so instance-sensitive) is only ever compared inside that one
 * copy, between the SDK's seed transaction and `canvasBinding`.
 *
 * The exemption is per-entry and per-rule on purpose: every other boundary
 * (Electron, Node builtins, filesystem, secrets) still applies to the canvas
 * graph in full.
 */
const EXTENSION_SDK_EXEMPT_ENTRIES = ['canvas'];

export const SINGLETON_CATEGORIES = [
  {
    name: 'React',
    test: (id) => /(^|\/)node_modules\/react(?:-dom)?(?:\/|$)/.test(id)
      || id === 'react'
      || id.startsWith('react/')
      || id === 'react-dom'
      || id.startsWith('react-dom/'),
  },
  {
    name: 'Lexical',
    test: (id) => /(^|\/)node_modules\/(?:@lexical\/[^/]+|lexical)(?:\/|$)/.test(id)
      || id === 'lexical'
      || id.startsWith('lexical/')
      || id.startsWith('@lexical/'),
  },
  {
    name: 'RevoGrid',
    test: (id) => /(^|\/)node_modules\/@revolist\/(?:react-datagrid|revogrid)(?:\/|$)/.test(id)
      || id === '@revolist/react-datagrid'
      || id.startsWith('@revolist/react-datagrid/')
      || id === '@revolist/revogrid'
      || id.startsWith('@revolist/revogrid/'),
  },
  {
    name: 'Yjs',
    test: (id) => /(^|\/)node_modules\/yjs(?:\/|$)/.test(id)
      || id === 'yjs'
      || id.startsWith('yjs/'),
  },
];

export function findBundledSingletons(modules) {
  return findBrowserDependencyViolations(
    modules.filter((module) => !module.external).map((module) => module.id),
    SINGLETON_CATEGORIES,
  );
}

const embeddedLaneCategories = [
  {
    name: 'Jotai',
    root(id) {
      return id.match(/^(.*\/node_modules\/jotai)(?:\/|$)/)?.[1] ?? null;
    },
  },
  {
    name: 'runtime store',
    root(id) {
      return id.match(/^(.*\/packages\/runtime)(?:\/src\/store(?:\/|$))/)?.[1]
        ?? id.match(/^(.*\/node_modules\/@nimbalyst\/runtime)(?:\/(?:dist\/)?store(?:\/|$))/)?.[1]
        ?? null;
    },
  },
];

export function findEmbeddedLaneViolations(modules) {
  const bundledIds = modules
    .filter((module) => !module.external)
    .map((module) => normalizeBrowserModuleId(module.id));
  return embeddedLaneCategories.flatMap((category) => {
    const roots = Array.from(new Set(bundledIds.map(category.root).filter(Boolean)));
    return roots.length > 1 ? [{ name: category.name, roots }] : [];
  });
}

function embeddedLaneSummary(modules) {
  const bundledIds = modules
    .filter((module) => !module.external)
    .map((module) => normalizeBrowserModuleId(module.id));
  return embeddedLaneCategories.map((category) => ({
    name: category.name,
    roots: Array.from(new Set(bundledIds.map(category.root).filter(Boolean))),
  }));
}

function chunkClosure(entry, chunksByFile, includeDynamicImports = true) {
  const seen = new Set();
  const visit = (fileName) => {
    if (seen.has(fileName)) return;
    const chunk = chunksByFile.get(fileName);
    if (!chunk) return;
    seen.add(fileName);
    for (const imported of chunk.imports) visit(imported);
    if (includeDynamicImports) {
      for (const imported of chunk.dynamicImports) visit(imported);
    }
  };
  visit(entry.fileName);
  return seen;
}

/**
 * Modules only the named entries can reach.
 *
 * A module shared with any other entry is deliberately absent: an exemption is
 * a statement about one entry's graph, and a dependency that leaks into a
 * shared chunk has stopped being that entry's business.
 */
export function findEntryExclusiveModuleIds(report, entryNames) {
  const chunksByFile = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));
  const modulesOf = (entry) => new Set(
    Array.from(chunkClosure(entry, chunksByFile))
      .flatMap((fileName) => chunksByFile.get(fileName)?.modules ?? [])
      .map(normalizeBrowserModuleId),
  );
  const exempt = new Set();
  const shared = new Set();
  for (const entry of report.chunks.filter((chunk) => chunk.isEntry)) {
    const target = entryNames.includes(entry.name) ? exempt : shared;
    for (const moduleId of modulesOf(entry)) target.add(moduleId);
  }
  for (const moduleId of shared) exempt.delete(moduleId);
  return exempt;
}

export function findEagerEntryFiles(report, entryName) {
  const chunksByFile = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = report.chunks.find((chunk) => chunk.isEntry && chunk.name === entryName);
  if (!entry) throw new Error(`entry chunk not found: ${entryName}`);
  return Array.from(chunkClosure(entry, chunksByFile, false));
}

/**
 * The personal lane, as a bundle-graph fact rather than a rendering condition.
 *
 * Favorites, unread dots, and snooze ride `CollabV3Sync` behind a personal JWT
 * and a PBKDF2-derived seed; the console holds team auth only. Both hosts render
 * the same tracker components, so "the browser does not show the star" used to
 * be a `personalState` conditional -- true today, one careless edit from being
 * inverted, and inert-but-present in the shipped bundle either way.
 *
 * The components now take the star and the dot as slots the host fills, so the
 * browser entry cannot contain them. This is what holds that: if a module from
 * the personal lane reappears in the `trackers-ui` closure, someone re-wired a
 * static import and the entry fails to build rather than shipping a live
 * affordance behind a flag.
 *
 * Kept narrow on purpose. `runtime/src/auth/jwtScopes` is deliberately absent --
 * it is where the *team* JWT brand lives, and `checkPublicJwtTypeBoundary`
 * requires the bundle to re-export it.
 */
export const TRACKERS_UI_FORBIDDEN_PERSONAL_LANE = [
  {
    // trackerUnreadAtoms, TrackerUnreadDot, and the receipt model they read.
    name: 'read-receipt / unread lane',
    test: (id) => id.includes('/runtime/src/readReceipts/'),
  },
  {
    name: 'favorite star',
    test: (id) => id.includes('/TrackerFavoriteStar.'),
  },
  {
    // CollabV3Sync is the personal transport and the PBKDF2 seed epoch;
    // trackerPersonalStateKey derives the favorite/opened LWW keys it carries.
    name: 'personal sync transport and key derivation',
    test: (id) => id.includes('/runtime/src/sync/CollabV3Sync.')
      || id.includes('/runtime/src/sync/trackerPersonalStateKey.'),
  },
  {
    // Redundant with the Electron rule today, and named anyway: a failure here
    // should say "personal JWT", not "some file under packages/electron".
    name: 'personal JWT acquisition',
    test: (id) => id.includes('/StytchAuthService.') || id.includes('/CredentialService.'),
  },
];

export function findTrackersUiPersonalLaneViolations(moduleIds) {
  return findBrowserDependencyViolations(moduleIds, TRACKERS_UI_FORBIDDEN_PERSONAL_LANE)
    .map(({ name, hits }) => `trackers-ui entry pulls the personal lane (${name}): ${hits.join(', ')}`);
}

/**
 * Drop SDK hits that only the exempt entries can reach; leave every other
 * category, and every shared hit, exactly as reported.
 */
export function applyExtensionSdkExemption(violations, exemptModuleIds) {
  return violations
    .map((violation) => (violation.name === 'extension SDK leakage'
      ? { ...violation, hits: violation.hits.filter((hit) => !exemptModuleIds.has(hit)) }
      : violation))
    .filter((violation) => violation.hits.length > 0);
}

export function findEntrySeparationViolations(report) {
  const chunksByFile = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));
  const entryByName = new Map(
    report.chunks.filter((chunk) => chunk.isEntry).map((chunk) => [chunk.name, chunk]),
  );
  const editor = entryByName.get('editor');
  const docsUi = entryByName.get('docs-ui');
  if (!editor || !docsUi) return ['Both editor and docs-ui entry chunks must exist.'];

  const moduleIdsFor = (entry) => Array.from(chunkClosure(entry, chunksByFile))
    .flatMap((fileName) => chunksByFile.get(fileName)?.modules ?? [])
    .map(normalizeBrowserModuleId);
  const editorModules = moduleIdsFor(editor);
  const docsUiModules = moduleIdsFor(docsUi);
  const violations = [];
  if (!docsUi.exports?.includes('createCollabDocsSession')) {
    violations.push('docs-ui entry does not export createCollabDocsSession');
  }
  if (editorModules.some((id) => id.includes('/collab-client/src/docs-ui/'))) {
    violations.push('editor entry pulls collab-client/docs-ui');
  }
  if (docsUiModules.some((id) => id.includes('/runtime/src/editor/')
    || id.includes('/runtime/src/collab-lexical/')
    || id.includes('/runtime/src/sync/CollabLexicalProvider.'))) {
    violations.push('docs-ui entry pulls the editor/codec graph');
  }
  if (!docsUiModules.some((id) => id.includes('/collab-client/src/docs/session.'))) {
    violations.push('docs-ui entry does not own the headless docs session');
  }
  if (!docsUiModules.some((id) => id.includes('/runtime/src/store/'))) {
    violations.push('docs-ui entry does not own the runtime store');
  }
  if (!docsUiModules.some((id) => /\/node_modules\/jotai(?:\/|$)/.test(id))) {
    violations.push('docs-ui entry does not own Jotai');
  }

  // Tracker item bodies mount through `./editor`, the entry the docs surface
  // already uses. A second Lexical graph here would be a second cold-paint
  // contract to get wrong (NIM-1764) on top of the bundle cost.
  const trackersUi = entryByName.get('trackers-ui');
  if (!trackersUi) {
    violations.push('trackers-ui entry chunk must exist');
  } else {
    const trackersUiModules = moduleIdsFor(trackersUi);
    if (trackersUiModules.some((id) => id.includes('/runtime/src/editor/')
      || id.includes('/runtime/src/collab-lexical/')
      || id.includes('/runtime/src/sync/CollabLexicalProvider.'))) {
      violations.push('trackers-ui entry pulls the editor/codec graph');
    }
    if (trackersUiModules.some((id) => id.includes('/collab-client/src/docs-ui/'))) {
      violations.push('trackers-ui entry pulls collab-client/docs-ui');
    }
    if (!trackersUiModules.some((id) => id.includes('/collab-client/src/trackers-ui/grid/'))) {
      violations.push('trackers-ui entry does not own the grid surface');
    }
    violations.push(...findTrackersUiPersonalLaneViolations(trackersUiModules));
  }
  return violations;
}

function resolveSingletonCopies() {
  const hostRequire = createRequire(path.join(repoRoot, 'package.json'));
  const bundleRequire = createRequire(path.join(packageRoot, 'package.json'));
  const packageNames = [
    'react',
    'react-dom',
    'lexical',
    '@lexical/yjs',
    '@revolist/react-datagrid',
    '@revolist/revogrid',
    'yjs',
  ];
  const resolvePackageRoot = (requireFrom, packageName) => {
    let cursor = path.dirname(requireFrom.resolve(packageName));
    while (cursor !== path.dirname(cursor)) {
      const manifestPath = path.join(cursor, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.name === packageName) return fs.realpathSync(manifestPath);
      }
      cursor = path.dirname(cursor);
    }
    throw new Error(`could not locate ${packageName}/package.json from ${requireFrom.resolve(packageName)}`);
  };
  return packageNames.map((packageName) => {
    const host = resolvePackageRoot(hostRequire, packageName);
    const bundle = resolvePackageRoot(bundleRequire, packageName);
    return { packageName, host, bundle, same: host === bundle };
  });
}

function checkSingletonPeerContract() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const requiredPeers = [
    'react',
    'react-dom',
    'lexical',
    '@lexical/yjs',
    '@revolist/react-datagrid',
    '@revolist/revogrid',
    'yjs',
  ];
  const missingPeers = requiredPeers.filter((name) => !manifest.peerDependencies?.[name]);
  const runtimeDependencies = requiredPeers.filter((name) => manifest.dependencies?.[name]);
  if (missingPeers.length > 0 || runtimeDependencies.length > 0) {
    throw new Error([
      'singleton peer contract is invalid:',
      missingPeers.length > 0 ? `  missing peers: ${missingPeers.join(', ')}` : null,
      runtimeDependencies.length > 0
        ? `  incorrectly bundled dependencies: ${runtimeDependencies.join(', ')}`
        : null,
    ].filter(Boolean).join('\n'));
  }
}

function checkPublicJwtTypeBoundary() {
  const publicTypesPath = path.join(packageRoot, 'types/editor.d.ts');
  const publicTypes = fs.readFileSync(publicTypesPath, 'utf8');
  const bundledRuntimeBrandPath = './internal/runtime/src/auth/jwtScopes';
  if (publicTypes.includes('@nimbalyst/runtime/auth/jwtScopes')) {
    throw new Error(
      'public editor types leak the workspace runtime JWT subpath; the bundled declaration '
      + 'must re-export the package-internal runtime brand.',
    );
  }
  if (!publicTypes.includes(`export type { TeamJwt, TeamMemberId } from '${bundledRuntimeBrandPath}'`)) {
    throw new Error(
      'public editor types must re-export TeamJwt and TeamMemberId from the bundled runtime declaration.',
    );
  }
  if (publicTypes.includes('declare const teamJwtBrand: unique symbol')
    || publicTypes.includes('declare const teamMemberIdBrand: unique symbol')) {
    throw new Error('public editor types must not duplicate runtime-owned JWT or member-id brands.');
  }
}

/**
 * Comments are stripped before scanning: these declaration files document the
 * public API, and documenting the recommended `@nimbalyst/runtime` import means
 * writing that import in an example. A raw source scan reads the example as a
 * real one and fails on a tree that has no leak at all, which is worse than
 * useless — it makes the check unpassable, so every push has to skip the hook
 * and the check stops guarding anything.
 *
 * A `//` inside a string literal is not a comment (`"virtual://shared-home"`
 * appears in the scanned declarations), so line stripping only applies when
 * nothing quoted precedes the `//` on that line. Block-comment stripping is
 * naive; a `/*` inside a string literal would confuse it, and none exists.
 */
export function stripComments(source) {
  // Replace with a space rather than nothing: `from/**/'@nimbalyst/runtime'`
  // must not be spliced into a token that no longer matches.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^([^\n'"`]*)\/\/[^\n]*$/gm, '$1 ');
}

export function findPublicTypeLeaks(declarationFiles, readFile) {
  return declarationFiles.flatMap((fileName) => Array.from(
    stripComments(readFile(fileName)).matchAll(
      /(?:from\s+|import\s*\()(['"])(@nimbalyst\/(?:collab-client|runtime|extension-sdk)(?:\/[^'"]*)?)\1/g,
    ),
    (match) => `${fileName}: ${match[2]}`,
  ));
}

function checkSelfContainedPublicTypes() {
  const typesRoot = path.join(packageRoot, 'types');
  const declarationFiles = fs.readdirSync(typesRoot, { recursive: true })
    .filter((fileName) => fileName.endsWith('.d.ts'));
  const leaks = findPublicTypeLeaks(
    declarationFiles,
    (fileName) => fs.readFileSync(path.join(typesRoot, fileName), 'utf8'),
  );
  if (leaks.length > 0) {
    throw new Error(
      'public declarations leak private workspace package boundaries:\n'
      + leaks.map((leak) => `  ${leak}`).join('\n'),
    );
  }
}

function measureFiles(files) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const relativePath of files) {
    const bytes = fs.readFileSync(path.join(distRoot, relativePath));
    rawBytes += bytes.byteLength;
    gzipBytes += gzipSync(bytes).byteLength;
  }
  return { files, rawBytes, gzipBytes };
}

function measureDist() {
  return measureFiles(
    fs.readdirSync(distRoot, { recursive: true })
      .filter((relativePath) => /\.(?:js|css)$/.test(relativePath)),
  );
}

export function checkCollabBundle() {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`bundle report missing at ${reportPath}; run the collab-bundle build first`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const bundledModuleIds = new Set(
    report.chunks.flatMap((chunk) => chunk.modules).map(normalizeBrowserModuleId),
  );
  const relevantModules = report.modules.filter((module) => (
    bundledModuleIds.has(normalizeBrowserModuleId(module.id))
    || (module.external && module.importers.some((importer) => (
      bundledModuleIds.has(normalizeBrowserModuleId(importer))
    )))
  ));
  const boundaryViolations = applyExtensionSdkExemption(
    findBrowserDependencyViolations(
      relevantModules.map((module) => module.id),
      COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES,
    ),
    findEntryExclusiveModuleIds(report, EXTENSION_SDK_EXEMPT_ENTRIES),
  );
  if (boundaryViolations.length > 0) {
    const details = boundaryViolations.flatMap(({ name, hits }) => [
      `${name}:`,
      ...hits.map((hit) => `  + ${hit}`),
    ]).join('\n');
    throw new Error(`collab browser entries reach forbidden dependencies:\n${details}`);
  }

  const bundledSingletons = findBundledSingletons(relevantModules);
  if (bundledSingletons.length > 0) {
    const details = bundledSingletons.flatMap(({ name, hits }) => [
      `${name}:`,
      ...hits.map((hit) => `  + ${hit}`),
    ]).join('\n');
    throw new Error(
      `host singletons were bundled instead of externalized:\n${details}\n`
      + 'React, Lexical, RevoGrid, and Yjs must be supplied once by the host page.',
    );
  }

  const embeddedLaneViolations = findEmbeddedLaneViolations(relevantModules);
  if (embeddedLaneViolations.length > 0) {
    throw new Error(
      'duplicate embedded state lanes:\n'
      + embeddedLaneViolations.flatMap(({ name, roots }) => [
        `${name}:`,
        ...roots.map((root) => `  ${root}`),
      ]).join('\n'),
    );
  }

  checkSingletonPeerContract();
  checkPublicJwtTypeBoundary();
  checkSelfContainedPublicTypes();
  const resolvedCopies = resolveSingletonCopies();
  const duplicateResolutions = resolvedCopies.filter((entry) => !entry.same);
  if (duplicateResolutions.length > 0) {
    throw new Error(
      'duplicate host singleton resolutions:\n'
      + duplicateResolutions.map((entry) => (
        `${entry.packageName}:\n  host: ${entry.host}\n  bundle: ${entry.bundle}`
      )).join('\n'),
    );
  }

  const separationViolations = findEntrySeparationViolations(report);
  if (separationViolations.length > 0) {
    throw new Error(`entry-point separation failed:\n${separationViolations.join('\n')}`);
  }

  const eagerEntries = Object.fromEntries(
    Object.entries(COLLAB_BUNDLE_EAGER_GZIP_BUDGET_BYTES).map(([entryName, budget]) => {
      const entrySize = measureFiles(findEagerEntryFiles(report, entryName));
      if (entrySize.gzipBytes > budget) {
        throw new Error(
          `${entryName} eager entry graph is ${entrySize.gzipBytes.toLocaleString()} gzip bytes, `
          + `over its ${budget.toLocaleString()}-byte ceiling. Statically loaded files: `
          + `${entrySize.files.join(', ')}. Check whether a lazy feature became a static import, `
          + 'or deliberately reset the measured eager budget.',
        );
      }
      return [entryName, { ...entrySize, gzipBudgetBytes: budget }];
    }),
  );

  const totalSize = measureDist();
  return {
    moduleCount: relevantModules.length,
    singletonCopies: resolvedCopies.length,
    embeddedLanes: embeddedLaneSummary(relevantModules),
    eagerEntries,
    totalRawBytes: totalSize.rawBytes,
    totalGzipBytes: totalSize.gzipBytes,
    totalFiles: totalSize.files,
  };
}

function formatEntrySize(entryName, entrySize) {
  return `[collab-bundle] ${entryName} eager size `
    + `${entrySize.rawBytes.toLocaleString()} raw / `
    + `${entrySize.gzipBytes.toLocaleString()} gzip bytes `
    + `(budget ${entrySize.gzipBudgetBytes.toLocaleString()} gzip).`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkCollabBundle();
    console.log(`[collab-bundle] browser graph clean (${result.moduleCount} modules).`);
    console.log(`[collab-bundle] singleton resolution clean (${result.singletonCopies} packages, one copy each).`);
    console.log(
      `[collab-bundle] embedded state lanes clean (${result.embeddedLanes.map(({ name }) => name).join(' and ')}, one root each).`,
    );
    for (const [entryName, entrySize] of Object.entries(result.eagerEntries)) {
      console.log(formatEntrySize(entryName, entrySize));
    }
    console.log(
      `[collab-bundle] total emitted output ${result.totalRawBytes.toLocaleString()} raw / `
      + `${result.totalGzipBytes.toLocaleString()} gzip bytes (informational; includes lazy chunks).`,
    );
  } catch (error) {
    console.error(`[collab-bundle] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
