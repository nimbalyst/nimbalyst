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
  editor: 320_000,
  'docs-ui': 70_000,
  'feedback-ui': 35_000,
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

export function findEagerEntryFiles(report, entryName) {
  const chunksByFile = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = report.chunks.find((chunk) => chunk.isEntry && chunk.name === entryName);
  if (!entry) throw new Error(`entry chunk not found: ${entryName}`);
  return Array.from(chunkClosure(entry, chunksByFile, false));
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
  return violations;
}

function resolveSingletonCopies() {
  const hostRequire = createRequire(path.join(repoRoot, 'package.json'));
  const bundleRequire = createRequire(path.join(packageRoot, 'package.json'));
  const packageNames = ['react', 'react-dom', 'lexical', '@lexical/yjs', 'yjs'];
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
  const requiredPeers = ['react', 'react-dom', 'lexical', '@lexical/yjs', 'yjs'];
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
  const boundaryViolations = findBrowserDependencyViolations(
    relevantModules.map((module) => module.id),
    COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES,
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
      + 'React, Lexical, and Yjs must be supplied once by the host page.',
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
