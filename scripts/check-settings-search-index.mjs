#!/usr/bin/env node
/**
 * Keeps Settings search in step with the settings pages (#1574), both ways.
 *
 * `settingsSearchIndex.ts` lists individual settings by the `data-testid` of
 * their row. Two ways that list goes wrong, both silently:
 *
 *   1. A row is renamed or removed, and its entry opens the page and goes
 *      nowhere. -> every anchor and exclusion must still exist.
 *   2. A new row is added and nobody lists it, so search never finds it.
 *      -> every `<SettingsToggle>` / `<DropdownRow>` on a settings page must
 *      carry a literal `testId` that is either listed or excluded with a reason.
 *
 * Rows whose `testId` is built at runtime (`testId={...}`) cannot be checked
 * statically and are skipped; their pages are still found by name.
 *
 * Usage:
 *   node scripts/check-settings-search-index.mjs    # check, exit 1 on any problem
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const INDEX_FILE = 'packages/electron/src/renderer/components/Settings/settingsSearchIndex.ts';
export const RENDERER_DIR = 'packages/electron/src/renderer';
/** Where settings pages live; only rows here must be searchable. */
export const SETTINGS_PAGE_DIRS = [
  'packages/electron/src/renderer/components/Settings',
  'packages/electron/src/renderer/components/GlobalSettings',
];

/** Every `anchor: '...'` in the index source. */
export function parseAnchors(src) {
  return [...src.matchAll(/\banchor:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The keys of `SETTINGS_SEARCH_EXCLUDED`. */
export function parseExcluded(src) {
  const block = src.match(/export const SETTINGS_SEARCH_EXCLUDED[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}

/** String-literal test ids: `data-testid="x"`, `testId="x"`, and the `{'x'}` / `{"x"}` forms. */
export function parseTestIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\b(?:data-testid|testId)=(?:"([^"]+)"|\{\s*['"]([^'"]+)['"]\s*\})/g)) {
    ids.add(m[1] ?? m[2]);
  }
  return ids;
}

/**
 * Each `<SettingsToggle ... />` / `<DropdownRow ... />` usage in a file, with
 * its literal testId, whether the testId is computed, and its name for the
 * error message.
 */
export function parseSettingRows(src, file) {
  const rows = [];
  for (const m of src.matchAll(/<(SettingsToggle|DropdownRow)\b([\s\S]*?)\/>/g)) {
    const props = m[2];
    const literal = props.match(/\btestId=(?:"([^"]+)"|\{\s*['"]([^'"]+)['"]\s*\})/);
    const name = props.match(/\bname=(?:"([^"]+)"|\{([^}]*)\})/);
    rows.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      name: name ? (name[1] ?? `{${name[2]}}`) : '(unnamed)',
      testId: literal ? (literal[1] ?? literal[2]) : null,
      dynamicTestId: !literal && /\btestId=\{/.test(props),
    });
  }
  return rows;
}

export function findUncoveredRows(rows, anchors, excluded) {
  const problems = [];
  for (const row of rows) {
    if (row.dynamicTestId) continue;
    const where = `${row.file}:${row.line} "${row.name}"`;
    if (!row.testId) {
      problems.push({ ...row, problem: `${where} has no testId` });
    } else if (!anchors.has(row.testId) && !excluded.has(row.testId)) {
      problems.push({ ...row, problem: `${where} (testId "${row.testId}") is not in the search list` });
    }
  }
  return problems;
}

export function findMissingAnchors(anchors, testIds) {
  return anchors.filter((anchor) => !testIds.has(anchor));
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(full) === '.tsx') out.push(full);
  }
  return out;
}

export function checkSettingsSearchIndex(root = repoRoot) {
  const indexSrc = readFileSync(join(root, INDEX_FILE), 'utf8');
  const anchors = parseAnchors(indexSrc);
  const excluded = parseExcluded(indexSrc);

  const testIds = new Set();
  for (const file of walk(join(root, RENDERER_DIR), [])) {
    for (const id of parseTestIds(readFileSync(file, 'utf8'))) testIds.add(id);
  }

  const rows = SETTINGS_PAGE_DIRS.flatMap((dir) =>
    walk(join(root, dir), []).flatMap((file) =>
      parseSettingRows(readFileSync(file, 'utf8'), relative(root, file).replace(/\\/g, '/'))));

  return {
    missingAnchors: findMissingAnchors([...anchors, ...excluded], testIds),
    uncoveredRows: findUncoveredRows(rows, new Set(anchors), new Set(excluded)).map((r) => r.problem),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { missingAnchors, uncoveredRows } = checkSettingsSearchIndex();
  if (missingAnchors.length > 0) {
    console.error('Settings search entries point at rows that no longer exist:');
    for (const anchor of missingAnchors) console.error(`  ${anchor}`);
    console.error(`Update ${INDEX_FILE}, or restore the row's data-testid.\n`);
  }
  if (uncoveredRows.length > 0) {
    console.error('Settings rows that search cannot find:');
    for (const problem of uncoveredRows) console.error(`  ${problem}`);
    console.error(
      `Give the row a testId, then add it to SETTINGS_SEARCH_ENTRIES in ${INDEX_FILE},\n` +
      'or to SETTINGS_SEARCH_EXCLUDED with the reason it should not be searchable.',
    );
  }
  if (missingAnchors.length > 0 || uncoveredRows.length > 0) process.exit(1);
  console.log('Settings search index: OK');
}
