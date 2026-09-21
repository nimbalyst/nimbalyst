#!/usr/bin/env node
/** Name-based AST gate for the promise-returning mobile sync API contract. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYNC_SCOPE = [
  'packages/runtime/src/sync',
  'packages/electron/src/main/services/sync',
  'packages/electron/src/main/services/SyncManager.ts',
  ...['MobileSyncHandler', 'mobileCreateRequestHandlers', 'pendingPromptPersistence', 'queuedPromptSyncPublisher']
    .map((name) => `packages/electron/src/main/services/ai/${name}.ts`),
];
export const SYNC_METHODS = new Set([
  'pushChange', 'syncSessionsToIndex', 'sendCreateSessionResponse',
  'sendCreateWorktreeResponse', 'sendSessionControlMessage', 'syncSettings',
  'syncProjectConfig', 'syncSettingsToMobile',
]);

function isTestFile(file) {
  return file.split(/[\\/]/).includes('__tests__') || /\.(test|spec)\.ts$/.test(file);
}

function sourceFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (isTestFile(full)) return [];
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return /\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function memberName(node) {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isSyncCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  const name = memberName(callee);
  if (SYNC_METHODS.has(name)) return true;
  return name && /^(send|publish)/.test(name)
    && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
    && ['syncProvider', 'provider'].includes(memberName(callee.expression));
}

function isDiscardingCallbackConsumer(call) {
  const callee = unwrap(call.expression);
  const name = memberName(callee);
  if (ts.isIdentifier(callee)) {
    return ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'].includes(name);
  }
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return ['on', 'once', 'addEventListener', 'forEach'].includes(name)
      || (name === 'nextTick' && ts.isIdentifier(unwrap(callee.expression))
        && unwrap(callee.expression).text === 'process');
  }
  return false;
}

function hasComment(statement, voidExpression, source) {
  const lineAt = (pos) => source.getLineAndCharacterOfPosition(pos).line;
  const first = lineAt(voidExpression.getStart(source));
  let found = false;
  const visit = (node) => {
    const ranges = [
      ...ts.getLeadingCommentRanges(source.text, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(source.text, node.end) ?? [],
    ];
    found ||= ranges.some((range) => lineAt(range.pos) <= first && lineAt(range.end) >= first - 1);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(statement);
  return found;
}

export function findFloatingSyncPromises(text, file = 'snippet.ts') {
  // Concurrent publication tests deliberately discard promises; this contract guards production callers.
  if (isTestFile(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations = [];
  // Follow only discarded expression results, not arguments or callback bodies.
  // Assignment, await, and return transfer responsibility to their caller.
  const inspect = (expression, statement, marked = false) => {
    const node = unwrap(expression);
    if (ts.isVoidExpression(node)) {
      inspect(node.expression, statement, hasComment(statement, node, source));
    } else if (isSyncCall(node)) {
      if (!marked) violations.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        method: memberName(unwrap(node.expression)) });
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // A bare .then/.catch chain still discards the resulting promise.
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        inspect(callee.expression, statement, marked);
      }
    } else if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue, statement, marked);
      inspect(node.whenFalse, statement, marked);
    } else if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(node.operatorToken.kind)) {
      inspect(node.left, statement, marked);
      inspect(node.right, statement, marked);
    }
  };
  const visit = (node) => {
    if (ts.isExpressionStatement(node)) inspect(node.expression, node);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      let argument = node;
      while (argument.parent && unwrap(argument.parent) !== argument.parent) argument = argument.parent;
      const parent = argument.parent;
      // Only known consumers discard callback results. Other concise arrows
      // propagate their result, including retry helpers and Promise chains.
      // Async does not make a discarded concise callback result safe.
      if (parent && ts.isCallExpression(parent) && parent.arguments.includes(argument)
        && isDiscardingCallbackConsumer(parent)) {
        inspect(node.body, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

export function checkSyncFloatingPromises(scope = SYNC_SCOPE) {
  const files = scope.flatMap((entry) => {
    const full = path.join(repoRoot, entry);
    if (!existsSync(full)) {
      console.error(`[sync-floating-promises] skipped missing scope entry: ${entry}`);
      return [];
    }
    return entry.endsWith('.ts') ? [full] : sourceFilesUnder(full);
  });
  const violations = files.sort().flatMap((file) => findFloatingSyncPromises(
    readFileSync(file, 'utf8'), path.relative(repoRoot, file).split(path.sep).join('/'),
  ));
  if (violations.length) throw new Error('sync promises must be awaited, returned, assigned, or explicitly marked:\n'
    + violations.map((v) => `  + ${v.file}:${v.line} ${v.method}`).join('\n')
    + '\nUse void only with a comment on the statement or the line above explaining why discarding is intentional.');
  return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = checkSyncFloatingPromises();
    console.log(`[sync-floating-promises] no floating sync promises (${count} files).`);
  } catch (error) {
    console.error(`[sync-floating-promises] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
