#!/usr/bin/env node
/**
 * Rewrites relative import specifiers in `dist-node/` to carry an explicit
 * `.js` (or `/index.js`) extension.
 *
 * Node's ESM resolver, unlike a bundler, will not guess an extension:
 * `import './SessionManager'` is `ERR_MODULE_NOT_FOUND`, full stop. Runtime's
 * source is written extensionless because every consumer until now was a
 * bundler -- Vite for the browser build, electron-vite for the desktop app --
 * and `tsc` does not rewrite specifiers on emit.
 *
 * `@nimbalyst/tracker-core` solves this the other way: its source writes
 * `./trackerRecord.js` directly, so its plain `tsc` output is Node-correct as
 * emitted. That is the better shape, and the right long-term fix here is to
 * match it. It is not what this script does, because the headless subset is 95
 * files with 133 relative specifiers across 41 of them, and rewriting live
 * source that the browser build also compiles is a much larger change than
 * adding a Node target. This runs over build output only and touches no source.
 *
 * Applied to `.d.ts` as well: a consumer typechecking under `node16`/`nodenext`
 * resolution holds declaration files to the same rule.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(packageRoot, 'dist-node');

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(entryPath);
    return /\.(js|d\.ts)$/.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * `./foo` may mean `./foo.js` or `./foo/index.js`. Resolve against what was
 * actually emitted rather than guessing, so a wrong answer fails the build here
 * instead of at the consumer's first import.
 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  if (/\.(js|mjs|cjs|json|css)$/.test(specifier)) return null;

  const target = path.resolve(path.dirname(fromFile), specifier);

  // File before directory, matching how Node and every bundler resolve it.
  // Checking the directory first meant `./foo` resolved to `foo/index.js` even
  // when `foo.js` existed beside it, silently running a different module, and
  // threw on a directory without an index even when `foo.js` was right there.
  if (existsSync(`${target}.js`)) {
    return `${specifier}.js`;
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    if (!existsSync(path.join(target, 'index.js'))) {
      throw new Error(`${path.relative(outDir, fromFile)} imports '${specifier}', a directory with no index.js`);
    }
    return `${specifier}/index.js`;
  }
  throw new Error(`${path.relative(outDir, fromFile)} imports '${specifier}', which did not emit`);
}

/** Every node that carries a module specifier, including bare and dynamic imports. */
function specifierNodes(source) {
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function rewrite(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);

  // Right to left, so an earlier edit cannot shift a later node's offsets.
  const edits = specifierNodes(source)
    .map((node) => ({ node, replacement: resolveSpecifier(filePath, node.text) }))
    .filter(({ replacement }) => replacement !== null)
    .sort((a, b) => b.node.getStart() - a.node.getStart());

  if (edits.length === 0) return 0;

  let updated = text;
  for (const { node, replacement } of edits) {
    const quote = text[node.getStart()];
    updated = updated.slice(0, node.getStart())
      + quote + replacement + quote
      + updated.slice(node.getEnd());
  }
  writeFileSync(filePath, updated);
  return edits.length;
}

if (!existsSync(outDir)) {
  throw new Error(`${path.relative(packageRoot, outDir)} does not exist -- run the tsc build first.`);
}

let rewritten = 0;
let touched = 0;
for (const filePath of filesUnder(outDir)) {
  const count = rewrite(filePath);
  if (count > 0) {
    touched += 1;
    rewritten += count;
  }
}
console.log(`[node-build] added extensions to ${rewritten} specifiers across ${touched} files.`);
