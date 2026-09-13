#!/usr/bin/env node
/**
 * Guards `packages/runtime` against reaching into a host.
 *
 * Runtime is the cross-platform layer: Electron, the mobile app, and the
 * headless node all sit above it. Two kinds of edge break that, and both have
 * happened:
 *
 * 1. Importing the `electron` npm package. Eight call sites read `app.isPackaged`
 *    and `app.getAppPath()` directly; they now go through the injected
 *    `HostEnvironment` (`src/host/hostEnvironment.ts`).
 * 2. A relative path that escapes the package into `packages/electron`.
 *    `ClaudeCodeProvider` imported `HistoryManager` this way, which pulled ~51
 *    files of the desktop app -- settings store, credential vault, logger --
 *    into the graph of anything touching session execution. It is now the
 *    `HistoryManagerPort` on `ClaudeCodeDeps`.
 *
 * Type-only imports count. They do not survive emit, but they force the whole
 * host graph through the typechecker, so a Node build still has to satisfy them.
 *
 * `src/electron/` is scanned like everything else: the directory name is
 * historical, and nothing under it may import Electron either.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runtimeSrc = path.join(repoRoot, 'packages/runtime/src');

/** Marker for a dynamic `import()` whose specifier is computed at runtime. */
export const UNRESOLVED_DYNAMIC_IMPORT = '\0unresolved-dynamic-import';

export const RUNTIME_FORBIDDEN_HOST_IMPORTS = [
  {
    name: 'electron',
    test: (id) => id === 'electron' || id.startsWith('electron/'),
  },
  {
    name: 'packages/electron',
    // Relative specifiers are resolved to absolute paths before this runs, so a
    // `../../../../../electron/src/main/...` escape shows up here.
    test: (id) => id.includes(`${path.sep}packages${path.sep}electron${path.sep}`)
      || id === '@nimbalyst/electron'
      || id.startsWith('@nimbalyst/electron/'),
  },
  {
    // Shipped code importing a test file would launder anything through the
    // scan's own exclusion: test files are not scanned, so an Electron import
    // inside one would never be seen.
    name: 'test file from shipped code',
    test: (id) => /(^|[\\/])__tests__[\\/]/.test(id)
      || /\.(test|spec)\.[cm]?tsx?$/.test(id)
      || /\.(test|spec)$/.test(id),
  },
];

export function findRuntimeHostViolations(entries) {
  return RUNTIME_FORBIDDEN_HOST_IMPORTS.flatMap(({ name, test }) => {
    const hits = entries.filter(({ specifier, resolved }) => test(resolved ?? specifier));
    return hits.length > 0 ? [{ name, hits }] : [];
  });
}

function sourceFilesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    // Tests are allowed to mock `electron`; only shipped source is guarded.
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return [];
    return /\.[cm]?tsx?$/.test(entry.name) ? [entryPath] : [];
  }).filter((filePath) => !filePath.includes(`${path.sep}__tests__${path.sep}`));
}

/** A string literal or a template with no substitutions, which is just as static. */
function staticText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Map every `const NAME = 'literal'` in the file.
 *
 * Indirecting a static specifier through a local const is a deliberate way to
 * stop a bundler from following the import (see `loadOpenCodeSdkClientModule`,
 * which pairs it with `webpackIgnore`). The specifier is still statically
 * known, so the gate resolves it rather than reporting a false unknown.
 */
function staticConstBindings(source) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer) {
      const text = staticText(node.initializer);
      if (text !== null) bindings.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function moduleSpecifiers(filePath) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const constBindings = staticConstBindings(source);
  const specifiers = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const text = staticText(node.moduleSpecifier);
      if (text !== null) specifiers.push(text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const text = staticText(node.argument.literal);
      if (text !== null) specifiers.push(text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      // `import electron = require('electron')`
      const text = staticText(node.moduleReference.expression);
      if (text !== null) specifiers.push(text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      // `require('electron')` survives in .cts and in code compiled to CJS.
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        const text = staticText(argument);
        const viaConst = text === null && argument && ts.isIdentifier(argument)
          ? constBindings.get(argument.text) ?? null
          : null;
        if (text !== null || viaConst !== null) {
          specifiers.push(text ?? viaConst);
        } else if (argument) {
          // Genuinely computed. Reported as a warning rather than a failure --
          // the gate should not claim to have proven what it could not read.
          specifiers.push(UNRESOLVED_DYNAMIC_IMPORT);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

export function collectRuntimeHostImports(root = runtimeSrc) {
  return sourceFilesUnder(root).flatMap((filePath) =>
    moduleSpecifiers(filePath).map((specifier) => ({
      file: path.relative(repoRoot, filePath),
      specifier,
      resolved: specifier.startsWith('.')
        ? path.resolve(path.dirname(filePath), specifier)
        : specifier,
    })));
}

export function checkRuntimeHostBoundary() {
  const entries = collectRuntimeHostImports();

  // Not a failure, but the gate says so out loud: these are the imports it
  // could not read, and therefore the part of the graph it did not prove.
  const unreadable = entries.filter((entry) => entry.resolved === UNRESOLVED_DYNAMIC_IMPORT);
  for (const entry of unreadable) {
    console.warn(`[runtime-host-boundary] unchecked computed import in ${entry.file}`);
  }

  const violations = findRuntimeHostViolations(entries);
  if (violations.length > 0) {
    const details = violations.flatMap(({ name, hits }) => [
      `${name}:`,
      ...hits.map((hit) => `  + ${hit.file} imports ${hit.specifier}`),
    ]).join('\n');
    throw new Error(
      `packages/runtime reaches into a host:\n${details}\n`
      + 'Inject the capability through ClaudeCodeDeps or HostEnvironment instead.',
    );
  }
  return entries.length;
}

/**
 * The session-execution and personal-sync modules a headless host imports.
 *
 * A source scan cannot protect this. The regression that motivated it was a
 * single *type-only* import of the `@nimbalyst/extension-sdk` barrel in
 * `ai/server/types.ts`: the barrel re-exports modules that import
 * `@nimbalyst/runtime`, closing a package cycle that pulled all 181 editor and
 * transcript components into the type graph. Nothing about that import line
 * looks wrong, and runtime imports that barrel in 25 other places where it is
 * entirely fine. Only the resulting closure distinguishes them.
 */
// Derive the roots from the build config so newly emitted entry points cannot
// silently escape the boundary gate. Keep measuring their SOURCE closure below.
const nodeConfigPath = path.join(repoRoot, 'packages/runtime/tsconfig.node.json');
const nodeConfig = ts.readConfigFile(nodeConfigPath, ts.sys.readFile);
if (nodeConfig.error) throw new Error(ts.flattenDiagnosticMessageText(nodeConfig.error.messageText, '\n'));
const nodeProgramConfig = ts.parseJsonConfigFileContent(nodeConfig.config, ts.sys, path.dirname(nodeConfigPath));
if (nodeProgramConfig.errors.length) {
  throw new Error(nodeProgramConfig.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
}
export const HEADLESS_ENTRY_POINTS = nodeProgramConfig.fileNames.map(file => path.relative(repoRoot, file));

// Headroom over the measured 143 so ordinary growth does not trip the gate. A
// re-introduced barrel cycle lands at 600+, so this catches the failure mode
// without policing every added module.
export const HEADLESS_CLOSURE_FILE_BUDGET = 200;

export function measureHeadlessClosure() {
  const configPath = path.join(repoRoot, 'packages/runtime/tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    { ...configFile.config, include: [], files: [] },
    ts.sys,
    path.dirname(configPath),
  );

  const program = ts.createProgram({
    rootNames: HEADLESS_ENTRY_POINTS.map((entry) => path.join(repoRoot, entry)),
    options: { ...parsed.options, noEmit: true, types: [] },
  });

  const projectFiles = program.getSourceFiles()
    .map((file) => file.fileName)
    .filter((fileName) => fileName.includes('/packages/') && !fileName.includes('/node_modules/'));

  return {
    files: projectFiles.length,
    tsx: projectFiles.filter((fileName) => fileName.endsWith('.tsx')).length,
    electron: projectFiles.filter((fileName) => fileName.includes('/packages/electron/')).length,
  };
}

export function checkHeadlessClosure() {
  const closure = measureHeadlessClosure();
  const problems = [];

  if (closure.tsx > 0) {
    problems.push(
      `${closure.tsx} .tsx files are reachable. A React component in this graph means a `
      + 'headless host cannot typecheck it. The usual cause is importing a barrel that '
      + 're-exports back into @nimbalyst/runtime -- import the deep path instead.',
    );
  }
  if (closure.electron > 0) {
    problems.push(`${closure.electron} packages/electron files are reachable.`);
  }
  if (closure.files > HEADLESS_CLOSURE_FILE_BUDGET) {
    problems.push(
      `closure is ${closure.files} files, over the ${HEADLESS_CLOSURE_FILE_BUDGET} budget.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `the headless entry points reach too far:\n${problems.map((p) => `  + ${p}`).join('\n')}`,
    );
  }

  return closure;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const importCount = checkRuntimeHostBoundary();
    console.log(`[runtime-host-boundary] runtime source clean (${importCount} imports scanned).`);
    const closure = checkHeadlessClosure();
    console.log(
      `[runtime-host-boundary] headless closure ${closure.files} files, `
      + `${closure.tsx} tsx, ${closure.electron} electron.`,
    );
  } catch (error) {
    console.error(`[runtime-host-boundary] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
