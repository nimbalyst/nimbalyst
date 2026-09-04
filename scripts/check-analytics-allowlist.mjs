#!/usr/bin/env node
/**
 * Fails when an analytics event name in source is not classified in
 * `posthogIngestAllowList.ts`.
 *
 * PostHog project 234047 runs a server-side ingestion transformation that drops
 * every event whose name is not on an explicit allow-list. An event that is not
 * on that list is constructed, serialized, sent, and silently discarded -- no
 * error, no log, no data. The failure is invisible until someone goes looking
 * for a metric that was never collected.
 *
 * This gate makes that decision explicit at review time: every event name found
 * in source must appear in exactly one of INGESTED_ALWAYS, INGESTED_SAMPLED, or
 * INTENTIONALLY_DROPPED. Adding an event forces you to say which it is.
 *
 * Detection is best-effort by design. It finds quoted literals at the known
 * emission seams; it cannot see an event whose name is computed at runtime.
 * A miss here means the gate stays quiet, never that it fires wrongly.
 *
 * Usage:
 *   node scripts/check-analytics-allowlist.mjs           # check, exit 1 on drift
 *   node scripts/check-analytics-allowlist.mjs --list    # print every name found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SCAN_ROOTS = [
  'packages/electron/src',
  'packages/runtime/src',
  'packages/ios/NimbalystNative/Sources',
  'packages/android/app/src/main',
];

/** Build output and vendored bundles contain the PostHog SDK's own event names. */
const EXCLUDED_DIR = /(^|[\\/])(node_modules|out|dist|build|coverage|__tests__|__mocks__)([\\/]|$)/;
const EXCLUDED_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SCANNED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.swift', '.kt']);

/**
 * Emission seams. The first captures positional calls
 * (`sendEvent('foo', ...)`), the second object-literal captures
 * (`capture({ event: 'foo' })`), which is how session start is emitted.
 */
const CALL_SITE = /(?:sendEvent|sendTeamAnalyticsEvent|trackTeamAnalyticsEvent|captureImmediate|capture)\(\s*["']([a-z$][a-z0-9_$]*)["']/g;
const EVENT_KEY = /\bevent:\s*["']([a-z$][a-z0-9_$]*)["']/g;

export const TEAM_SCHEMA_FILE = 'packages/electron/src/shared/analytics/teamAnalytics.ts';
export const ALLOW_LIST_FILE = 'packages/electron/src/shared/analytics/posthogIngestAllowList.ts';

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (EXCLUDED_DIR.test(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCANNED_EXT.has(extname(full)) && !EXCLUDED_FILE.test(full)) out.push(full);
  }
  return out;
}

/** Event names declared as keys of the team analytics schema map. */
function teamSchemaEvents() {
  const src = readFileSync(join(repoRoot, TEAM_SCHEMA_FILE), 'utf8');
  const start = src.indexOf('export const TEAM_ANALYTICS_EVENT_SCHEMAS');
  if (start === -1) return new Map();
  const body = src.slice(start, src.indexOf('\n} as const', start));
  const found = new Map();
  for (const m of body.matchAll(/^ {2}([a-z][a-z0-9_]*):\s*\{/gm)) {
    found.set(m[1], `${TEAM_SCHEMA_FILE} (schema key)`);
  }
  return found;
}

/** Parse a `const NAME = [...]` string-array out of the allow-list module. */
export function parseList(src, name) {
  const m = src.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`Could not parse ${name} from ${ALLOW_LIST_FILE}`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/** Every analytics event name reachable from source, mapped to where it was first seen. */
export function collectEventNames() {
  const found = teamSchemaEvents();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const src = readFileSync(file, 'utf8');
      const where = relative(repoRoot, file);
      for (const re of [CALL_SITE, EVENT_KEY]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) if (!found.has(m[1])) found.set(m[1], where);
      }
    }
  }
  return found;
}

/**
 * Pure classification step: returns one message per problem, empty when clean.
 * `found` is a Map of name -> where; `lists` holds the four Sets.
 */
export function findClassificationErrors(found, lists) {
  const { always, sampled, dropped, sdkOwned } = lists;
  const errors = [];

  for (const [name, where] of [...found].sort()) {
    const count = [always, sampled, dropped, sdkOwned].filter((s) => s.has(name)).length;
    if (count === 0) {
      errors.push(
        `  ${name}\n    first seen: ${where}\n` +
          `    -> Not classified. Add it to INGESTED_ALWAYS, INGESTED_SAMPLED or\n` +
          `       INTENTIONALLY_DROPPED in ${ALLOW_LIST_FILE}.\n` +
          `       If you want the data, you must ALSO add the name to the\n` +
          `       'Cost control allow-list' transformation in PostHog project 234047,\n` +
          `       or it will be silently dropped at ingestion.`,
      );
    } else if (count > 1) {
      errors.push(`  ${name}\n    -> Classified in more than one list; it must appear in exactly one.`);
    }
  }

  for (const [label, set] of [['INGESTED_ALWAYS', always], ['INGESTED_SAMPLED', sampled]]) {
    for (const name of set) {
      if (!found.has(name) && !sdkOwned.has(name)) {
        errors.push(
          `  ${name}\n    -> Listed in ${label} but no longer emitted anywhere in source.\n` +
            `       Remove it from the PostHog transformation and from this list.`,
        );
      }
    }
  }

  return errors;
}

export function readLists() {
  const src = readFileSync(join(repoRoot, ALLOW_LIST_FILE), 'utf8');
  return {
    always: parseList(src, 'INGESTED_ALWAYS'),
    sampled: parseList(src, 'INGESTED_SAMPLED'),
    dropped: parseList(src, 'INTENTIONALLY_DROPPED'),
    sdkOwned: parseList(src, 'SDK_OWNED'),
  };
}

function main() {
  const found = collectEventNames();

  if (process.argv.includes('--list')) {
    for (const name of [...found.keys()].sort()) console.log(name);
    return;
  }

  const errors = findClassificationErrors(found, readLists());

  if (errors.length) {
    console.error(`\nAnalytics allow-list check failed (${errors.length} issue(s)):\n`);
    console.error(errors.join('\n\n'));
    console.error(`\nSee "A server-side allow-list drops unknown events" in docs/POSTHOG_EVENTS.md.\n`);
    process.exit(1);
  }

  console.log(`Analytics allow-list OK - ${found.size} event names, all classified.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
