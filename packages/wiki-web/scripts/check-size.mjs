/**
 * Size budget for the `@nimbalyst/wiki-web` build.
 *
 * Two numbers, both gzip:
 *  - eager: what `index.html` loads before the first paint (its script, the
 *    modulepreload links Vite writes for the entry's static imports, and its
 *    stylesheets). This is what every open of the wiki pays.
 *  - total: everything in dist, which is what `npm install` downloads. Most of
 *    it is lazy chunks (mermaid and its diagram engines, katex, the prettier
 *    parsers) fetched only when a page needs them.
 *
 * The budgets sit just above the first measured build. Raising one is fine
 * when the growth is intended: change the number and the dated comment, and
 * say what grew.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// 2026-10-08, first build: eager 789,223 B gzip (2,805,300 B raw); total 2,918,092 B gzip (9,539,550 B raw).
const EAGER_GZIP_BUDGET_BYTES = 810_000;
const TOTAL_GZIP_BUDGET_BYTES = 3_000_000;

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

function sizes(file) {
  const bytes = readFileSync(file);
  // Fonts and images are already compressed; gzip would not shrink them on the wire either.
  const gzip = /\.(woff2?|png|jpe?g|gif|webp|ico)$/i.test(file) ? bytes.length : gzipSync(bytes, { level: 9 }).length;
  return { raw: bytes.length, gzip };
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const eagerFiles = new Set([path.join(dist, 'index.html')]);
for (const match of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) eagerFiles.add(path.join(dist, match[1]));

const sum = (files) => [...files].map(sizes).reduce((a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip }), { raw: 0, gzip: 0 });
const eager = sum(eagerFiles);
const all = walk(dist);
const total = sum(all);
const fmt = (n) => n.toLocaleString('en-US');

console.log(`wiki-web eager: ${fmt(eager.raw)} B raw, ${fmt(eager.gzip)} B gzip (${eagerFiles.size} files; budget ${fmt(EAGER_GZIP_BUDGET_BYTES)} B gzip)`);
console.log(`wiki-web total: ${fmt(total.raw)} B raw, ${fmt(total.gzip)} B gzip (${all.length} files; budget ${fmt(TOTAL_GZIP_BUDGET_BYTES)} B gzip)`);

let failed = false;
if (eager.gzip > EAGER_GZIP_BUDGET_BYTES) {
  console.error(`wiki-web eager load is over budget by ${fmt(eager.gzip - EAGER_GZIP_BUDGET_BYTES)} B gzip`);
  failed = true;
}
if (total.gzip > TOTAL_GZIP_BUDGET_BYTES) {
  console.error(`wiki-web dist is over budget by ${fmt(total.gzip - TOTAL_GZIP_BUDGET_BYTES)} B gzip`);
  failed = true;
}
process.exit(failed ? 1 : 0);
