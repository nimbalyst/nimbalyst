#!/usr/bin/env node
/**
 * Guards the headless collab-client entries against browser/UI/desktop creep.
 *
 * Both the source imports and the bundled dependency graph are checked. The
 * source pass catches type-only imports that bundlers erase; the esbuild pass
 * catches transitive runtime dependencies. `docs-ui` is deliberately not an
 * entry point here because React UI is allowed there.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  collectBrowserBundleGraph,
  findBrowserDependencyViolations,
  normalizeBrowserModuleId,
} from './browser-bundle-graph.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const collabClientRoot = path.join(repoRoot, 'packages/collab-client');
const collabClientPackage = JSON.parse(readFileSync(
  path.join(collabClientRoot, 'package.json'),
  'utf8',
));

function defaultExportTarget(definition) {
  if (typeof definition === 'string') return definition;
  if (!definition || typeof definition !== 'object') return null;
  if (typeof definition.default === 'string') return definition.default;
  if (typeof definition.import === 'string') return definition.import;
  return defaultExportTarget(definition.default ?? definition.import);
}

/** Derive every headless subpath from package exports so new domains are guarded automatically. */
export function deriveCollabClientHeadlessEntryPoints(exportsMap, packageRoot) {
  return Object.fromEntries(Object.entries(exportsMap ?? {}).flatMap(([subpath, definition]) => {
    const name = subpath.replace(/^\.\//, '');
    if (!name || name === 'ui' || name.endsWith('-ui')) return [];
    const target = defaultExportTarget(definition);
    return target ? [[name, path.resolve(packageRoot, target)]] : [];
  }));
}

const headlessEntryPoints = deriveCollabClientHeadlessEntryPoints(
  collabClientPackage.exports,
  collabClientRoot,
);
const headlessSourceDirs = Array.from(new Set(
  Object.values(headlessEntryPoints).map((entryPoint) => path.dirname(entryPoint)),
));

export const COLLAB_CLIENT_FORBIDDEN_DEPENDENCIES = [
  {
    name: 'react-dom',
    test: (id) => /(^|\/)(?:node_modules\/)?react-dom(?:\/|$)/.test(id),
  },
  {
    name: '@nimbalyst/extension-sdk',
    test: (id) => id === '@nimbalyst/extension-sdk'
      || id.startsWith('@nimbalyst/extension-sdk/')
      || id.includes('/packages/extension-sdk/')
      || id.includes('/node_modules/@nimbalyst/extension-sdk/'),
  },
  {
    name: 'Electron',
    test: (id) => id === 'electron'
      || id.startsWith('electron/')
      || id.includes('/packages/electron/')
      || id.includes('/node_modules/electron/'),
  },
  {
    name: 'node:*',
    test: (id) => id.startsWith('node:'),
  },
];

export function findCollabClientBoundaryViolations(moduleIds) {
  return findBrowserDependencyViolations(
    moduleIds,
    COLLAB_CLIENT_FORBIDDEN_DEPENDENCIES,
  );
}

function sourceFilesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return /\.[cm]?tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function sourceModuleSpecifiers(filePath) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function findForbiddenSourceImports() {
  const imports = [];
  for (const directory of headlessSourceDirs) {
    for (const filePath of sourceFilesUnder(directory)) {
      for (const specifier of sourceModuleSpecifiers(filePath)) {
        const resolvedId = specifier.startsWith('.')
          ? path.resolve(path.dirname(filePath), specifier)
          : specifier;
        imports.push(normalizeBrowserModuleId(resolvedId));
      }
    }
  }
  return findCollabClientBoundaryViolations(imports);
}

export async function checkCollabClientBoundaries() {
  const sourceViolations = findForbiddenSourceImports();
  let graph;
  try {
    graph = await collectBrowserBundleGraph({
      repoRoot,
      entryPoints: headlessEntryPoints,
      outdir: path.join(repoRoot, '.collab-client-boundary'),
      treeShaking: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not build headless entries for boundary analysis: ${message}`);
  }

  const graphViolations = findCollabClientBoundaryViolations(graph.moduleIds);
  const violations = [...sourceViolations, ...graphViolations];
  if (violations.length > 0) {
    const details = violations.flatMap(({ name, hits }) => [
      `${name}:`,
      ...hits.map((hit) => `  + ${hit}`),
    ]).join('\n');
    throw new Error(
      `collab-client headless entries reach forbidden dependencies:\n${details}\n`
      + 'Move UI/desktop dependencies behind docs-ui or a host adapter.',
    );
  }

  return Object.keys(graph.metafile.inputs).length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const moduleCount = await checkCollabClientBoundaries();
    const entryLabel = Object.keys(headlessEntryPoints).join('/');
    console.log(`[collab-client-boundaries] ${entryLabel} graph clean (${moduleCount} modules).`);
  } catch (error) {
    console.error(`[collab-client-boundaries] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
