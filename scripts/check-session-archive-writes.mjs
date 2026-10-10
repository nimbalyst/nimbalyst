#!/usr/bin/env node
/**
 * Fails on renderer code that archives or unarchives a session by calling
 * `invoke('sessions:update-metadata', id, { isArchived ... })` directly.
 *
 * A rejected save returns `{ success: false }` instead of throwing, so a
 * direct call that ignores the result leaves the session looking archived
 * with no error shown (GitHub #282).
 * Use `saveSessionArchived` (renderer/utils/saveSessionArchived.ts) instead:
 * it reads the result and shows the error.
 *
 * Parses with the TypeScript compiler so comments, strings, and calls that
 * write other metadata fields are not flagged.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export const SCAN_ROOTS = ['packages/electron/src/renderer'];
// The helper itself makes the one allowed direct call.
const HELPER = 'packages/electron/src/renderer/utils/saveSessionArchived.ts';
const CHANNEL = 'sessions:update-metadata';

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

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isInvokeCallee(callee) {
  return (ts.isIdentifier(callee) && callee.text === 'invoke')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'invoke');
}

/** True when an object literal has an `isArchived` key, written in full or as shorthand. */
function hasIsArchivedKey(node) {
  return ts.isObjectLiteralExpression(node) && node.properties.some(
    prop => (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
      && prop.name && ts.isIdentifier(prop.name) && prop.name.text === 'isArchived',
  );
}

/** Returns `{ line }` for every direct `sessions:update-metadata` call that sets `isArchived`. */
export function findArchiveWrites(source, fileName = 'file.tsx') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && isInvokeCallee(node.expression)
      && node.arguments[0] && isStringLiteral(node.arguments[0]) && node.arguments[0].text === CHANNEL
      && node.arguments.some(hasIsArchivedKey)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push({ line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export function checkArchiveWrites(roots = SCAN_ROOTS) {
  const failures = [];
  for (const root of roots) {
    for (const file of listSourceFiles(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file);
      if (relative === HELPER) continue;
      for (const hit of findArchiveWrites(readFileSync(file, 'utf8'), file)) {
        failures.push(`${relative}:${hit.line}: ${CHANNEL} with isArchived`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkArchiveWrites();
  if (failures.length) {
    console.error('Archive state must be saved through saveSessionArchived (renderer/utils/saveSessionArchived.ts):');
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('No direct archive writes found.');
  }
}
