#!/usr/bin/env node
/**
 * Fetch every module the renderer page imports from a running Vite dev server,
 * so its transform cache is warm before Electron loads the page.
 *
 * A cold server compiles the renderer graph (~2,600 modules) on the first page
 * load, which takes longer than the E2E beforeAll timeouts allow. Vite's own
 * `server.warmup` runs in the background with no completion signal; this walks
 * the import graph the same way the browser would and exits when it is done.
 *
 * Usage: node scripts/warm-renderer.mjs http://127.0.0.1:5373
 */

const base = process.argv[2];
if (!base) {
  console.error('usage: warm-renderer.mjs <dev server url>');
  process.exit(1);
}

const CONCURRENCY = 16;
// Specifiers Vite serves: root-absolute (`/App.tsx`, `/@fs/...`) or, in
// index.html, relative to the page (`./index.tsx`).
const SPEC = String.raw`((?:\.{1,2})?\/[^"']+)`;
const IMPORT_PATTERNS = [
  new RegExp(String.raw`\b(?:import|export)\s*(?:[^'"\x60;]*?\bfrom\s*)?["']` + SPEC + `["']`, 'g'),
  new RegExp(String.raw`\bimport\(\s*["']` + SPEC + String.raw`["']\s*\)`, 'g'),
  new RegExp(String.raw`<script[^>]+\bsrc=["']` + SPEC + `["']`, 'g'),
];

const seen = new Set(['/']);
const queue = ['/'];
let failed = 0;
const started = Date.now();

async function visit(url) {
  let body;
  try {
    const response = await fetch(new URL(url, base));
    if (!response.ok) {
      failed++;
      return;
    }
    body = await response.text();
  } catch {
    failed++;
    return;
  }
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const resolved = new URL(match[1], new URL(url, base));
      const next = resolved.pathname + resolved.search;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
}

const inFlight = new Set();
while (queue.length > 0 || inFlight.size > 0) {
  while (queue.length > 0 && inFlight.size < CONCURRENCY) {
    const task = visit(queue.shift()).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  await Promise.race(inFlight);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[warm-renderer] ${seen.size} modules in ${seconds}s (${failed} failed)`);
