#!/usr/bin/env node
/**
 * Guards the Electron main bundle against renderer/editor module creep.
 *
 * Main is a Node process. It has no DOM, never renders, and never calls a
 * Lexical node's `decorate()`. When renderer-only modules end up in its graph
 * anyway, Rollup watches them -- so editing a UI file rebuilds main and
 * electron-vite restarts the app, reloading EVERY open workspace window.
 *
 * This check exists because that exact regression survived a fix undetected:
 * commit dc54c19a5 narrowed the bare `@nimbalyst/runtime` specifier, but the
 * editor graph kept arriving through SUBPATH imports
 * (`@nimbalyst/runtime/sync` -> MarkdownCollabContentAdapter ->
 * HeadlessLexicalYDoc -> headlessBodyNodes -> ImageNode.tsx -> react-dom).
 * Export-completeness was verified; the resulting bundle graph was not.
 *
 * Usage:
 *   node scripts/check-main-bundle-graph.mjs            # exit 1 if anything is over budget
 *   node scripts/check-main-bundle-graph.mjs --warn     # report only, always exits 0
 *   node scripts/check-main-bundle-graph.mjs --map PATH # validate a specific sourcemap
 *
 * Every budget is now 0: conversion runs on a codec host (the renderer today;
 * the web console and mobile WKWebView next), and main is a client of that
 * contract with no codecs of its own. See
 * nimbalyst-local/plans/collab-conversion-off-main.md.
 *
 * If a budget goes non-zero, do NOT raise it -- find what main started
 * importing. The usual cause is a barrel re-export: the runtime package is not
 * marked side-effect-free, so anything reachable from `@nimbalyst/runtime/sync`
 * lands in main even with no importer. That is why the Lexical-coupled modules
 * live behind `@nimbalyst/runtime/collab-lexical` instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAIN_BUNDLE_GRAPH_CATEGORIES,
  normalizeMainBundleModuleId,
} from './main-bundle-graph-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mapArgIndex = process.argv.indexOf('--map');
const mapPath = mapArgIndex >= 0 && process.argv[mapArgIndex + 1]
  ? path.resolve(process.cwd(), process.argv[mapArgIndex + 1])
  : path.join(repoRoot, 'packages/electron/out/main/index.js.map');

const strict = !process.argv.includes('--warn');

if (!fs.existsSync(mapPath)) {
  console.log(`[bundle-graph] no main sourcemap at ${mapPath} -- skipping.`);
  console.log('[bundle-graph] run a development build for sourcemap diagnostics; production builds enforce the same policy inside Rollup.');
  process.exit(strict ? 1 : 0);
}

let sources;
try {
  // The map is large (~27MB); parse once and keep only `sources`.
  sources = JSON.parse(fs.readFileSync(mapPath, 'utf8')).sources ?? [];
} catch (err) {
  console.error(`[bundle-graph] could not parse sourcemap: ${err.message}`);
  process.exit(strict ? 1 : 0);
}

// Normalise the leading ../../../.. so paths read as repo-relative.
const normalized = sources.map(normalizeMainBundleModuleId);

let over = 0;
console.log(`[bundle-graph] main bundle contains ${normalized.length} modules\n`);

for (const cat of MAIN_BUNDLE_GRAPH_CATEGORIES) {
  const hits = normalized.filter(cat.test);
  const status = hits.length > 0 ? 'OVER' : 'ok';
  if (hits.length > 0) over++;
  console.log(
    `  ${status.padEnd(4)} ${cat.name.padEnd(22)} ${String(hits.length).padStart(4)} (budget 0)`
  );
  if (hits.length > 0) {
    for (const p of hits.slice(0, 10)) console.log(`         + ${p}`);
    if (hits.length > 10) console.log(`         ... and ${hits.length - 10} more`);
  }
}

if (over > 0) {
  console.log(
    `\n[bundle-graph] ${over} categor${over === 1 ? 'y is' : 'ies are'} over budget -- ` +
      'renderer-only modules are being pulled into the Electron main graph.'
  );
  console.log('[bundle-graph] every module here makes editing that file restart the app.');
  process.exit(strict ? 1 : 0);
}

console.log('\n[bundle-graph] within budget.');
