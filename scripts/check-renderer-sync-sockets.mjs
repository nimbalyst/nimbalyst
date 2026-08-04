#!/usr/bin/env node
/**
 * Guards every renderer-side sync provider against opening a raw browser
 * WebSocket to the collab sync server.
 *
 * The sync server gates `/sync/` upgrades on an Origin allowlist. Chromium
 * always stamps an Origin (the dev renderer is `http://localhost:5273`, which
 * production does not allow), while a main-process `ws` client sends none --
 * that absence is how the server recognises a native client. So a renderer
 * provider that falls through to `new WebSocket(url)` is rejected with a 403 the
 * browser reports only as an opaque 1006 close with no reason.
 *
 * That is exactly how Shared Docs broke on 2026-08-03: `TeamSyncProvider` was
 * the one provider whose renderer call site never passed `createWebSocket`, so
 * it used the platform socket and every team connection died silently. The fix
 * is always the same -- pass `createProxiedWebSocket` (or forward a config that
 * already carries it) so the socket is opened in the main process.
 *
 * This checks the renderer *call sites*, not the providers: the raw
 * `new WebSocket(url)` fallback inside `packages/runtime/src/sync/*` is correct
 * for the main process, which constructs the same providers legitimately.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const rendererRoot = path.join(repoRoot, 'packages/electron/src/renderer');

/** Sync providers that open a `/sync/{roomId}` socket and accept a `createWebSocket` hook. */
export const SYNC_PROVIDER_CONSTRUCTORS = new Set([
  'TeamSyncProvider',
  'DocumentSyncProvider',
  'TrackerSyncEngine',
  'ConversationSync',
  'ProjectSyncProvider',
  'TeamInboxOrgClient',
  'TeamInboxFanIn',
]);

/** Factory functions that construct a sync provider internally. */
export const SYNC_PROVIDER_FACTORIES = new Set(['createCollabV3Sync']);

/**
 * Call sites whose config is assembled from a parameter this checker cannot
 * follow. Each entry must name the upstream that does pass `createWebSocket`.
 */
export const ALLOWLIST = [
  {
    file: 'services/BodyDocCache.ts',
    reason:
      'Spreads the caller-supplied DocumentSyncConfig; useTrackerContentCollab and '
      + 'useTrackerBodyPrewarm both build it from resolveDesktopCollabConfigForUri, '
      + 'which sets createWebSocket.',
  },
];

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'out' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `const X = <init>` in the file, so an identifier argument can be resolved. */
function collectLocalInitializers(sourceFile) {
  const byName = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      byName.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return byName;
}

/** True if `createWebSocket` is set anywhere in the config expression. */
function mentionsCreateWebSocket(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    const name = (ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child))
      && child.name
      && ts.isIdentifier(child.name)
      ? child.name.text
      : null;
    if (name === 'createWebSocket') {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * Resolve the config expression a provider was constructed with, following an
 * identifier and one level of `{ ...other }` spread within the same file.
 *
 * Returns 'proxied', 'raw', or 'unresolved'. 'unresolved' means the config
 * arrived as a parameter (a lambda argument, a factory seam) that this file
 * cannot follow -- the caller then falls back to a file-level check rather than
 * guessing in either direction.
 */
function configCarriesProxy(argument, initializers, seen = new Set()) {
  if (!argument) return 'raw';
  let expression = argument;
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return 'unresolved';
    seen.add(expression.text);
    const resolved = initializers.get(expression.text);
    if (!resolved) return 'unresolved';
    expression = resolved;
  }
  if (mentionsCreateWebSocket(expression)) return 'proxied';

  const spreads = [];
  const collect = (child) => {
    if (ts.isSpreadAssignment(child) && ts.isIdentifier(child.expression)) {
      spreads.push(child.expression);
    }
    ts.forEachChild(child, collect);
  };
  collect(expression);
  const results = spreads.map((spread) => configCarriesProxy(spread, initializers, seen));
  if (results.includes('proxied')) return 'proxied';
  if (results.includes('unresolved')) return 'unresolved';
  return 'raw';
}

export function findUnproxiedSyncSockets(files = listSourceFiles(rendererRoot)) {
  const violations = [];
  for (const file of files) {
    const relative = path.relative(rendererRoot, file);
    if (ALLOWLIST.some((entry) => entry.file === relative)) continue;
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const initializers = collectLocalInitializers(sourceFile);

    const visit = (node) => {
      const isProviderCtor = ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && SYNC_PROVIDER_CONSTRUCTORS.has(node.expression.text);
      const isProviderFactory = ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && SYNC_PROVIDER_FACTORIES.has(node.expression.text);
      if (isProviderCtor || isProviderFactory) {
        const verdict = configCarriesProxy(node.arguments?.[0], initializers);
        // An unfollowable config still has to be wired somewhere in this file;
        // that is the weakest claim that stays true, and it is the one that
        // fails for a file which never mentions the proxy at all.
        const ok = verdict === 'proxied'
          || (verdict === 'unresolved' && mentionsCreateWebSocket(sourceFile));
        if (!ok) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: relative,
            line: line + 1,
            provider: node.expression.text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

export function checkRendererSyncSockets() {
  const violations = findUnproxiedSyncSockets();
  if (violations.length > 0) {
    throw new Error(
      'renderer sync providers must open sockets through the main process:\n'
      + violations.map((v) => `  + ${v.file}:${v.line} ${v.provider} has no createWebSocket`).join('\n')
      + '\nPass `createWebSocket: createProxiedWebSocket` (renderer/utils/proxiedWebSocket.ts),\n'
      + 'or forward a config that already carries it. A browser WebSocket sends an Origin\n'
      + 'the sync server rejects, which surfaces only as an opaque 1006 close.',
    );
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkRendererSyncSockets();
    console.log('[renderer-sync-sockets] all renderer sync providers use the main-process proxy.');
  } catch (error) {
    console.error(`[renderer-sync-sockets] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
