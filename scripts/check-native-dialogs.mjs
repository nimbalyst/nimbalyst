#!/usr/bin/env node
/**
 * Fails on native browser dialogs (`confirm`, `alert`, `prompt`) in renderer,
 * runtime, and collab-client source.
 *
 * A native dialog blocks the renderer thread, so Playwright has to install a
 * `page.on('dialog')` handler before every action that might raise one or the
 * E2E run hangs; and it renders as OS chrome rather than the app's dialogs.
 * Use `requestConfirmation` (dialogs/requestConfirmation.ts) for confirms and
 * `errorNotificationService` for alerts instead.
 *
 * Parses with the TypeScript compiler so comments, strings, and in-app
 * helpers that happen to be named `confirm` (a destructured
 * `const { confirm } = useDialog()`) are not flagged.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export const SCAN_ROOTS = ['packages/electron/src/renderer', 'packages/runtime/src', 'packages/collab-client/src'];
const NATIVE_DIALOGS = new Set(['confirm', 'alert', 'prompt']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'out' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Names bound anywhere in the file, so a local `confirm` is not mistaken for the global. */
function collectDeclaredNames(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node)
        || ts.isNamespaceImport(node))
      && node.name && ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** Returns `{ line, call }` for every native dialog call in `source`. */
export function findNativeDialogCalls(source, fileName = 'file.tsx') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const declared = collectDeclaredNames(sourceFile);
  const hits = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name = null;
      if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && GLOBAL_OBJECTS.has(callee.expression.text)
        && NATIVE_DIALOGS.has(callee.name.text)
      ) {
        name = `${callee.expression.text}.${callee.name.text}`;
      } else if (ts.isIdentifier(callee) && NATIVE_DIALOGS.has(callee.text) && !declared.has(callee.text)) {
        name = callee.text;
      }
      if (name) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hits.push({ line: line + 1, call: name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export function checkNativeDialogs(roots = SCAN_ROOTS) {
  const failures = [];
  for (const root of roots) {
    for (const file of listSourceFiles(path.join(repoRoot, root))) {
      for (const hit of findNativeDialogCalls(readFileSync(file, 'utf8'), file)) {
        failures.push(`${path.relative(repoRoot, file)}:${hit.line}: ${hit.call}()`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkNativeDialogs();
  if (failures.length) {
    console.error('Native browser dialogs are not allowed. Use requestConfirmation or errorNotificationService:');
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('No native dialogs found.');
  }
}
