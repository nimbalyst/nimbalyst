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
const CALL_SITE = /(?:sendEvent|sendTeamAnalyticsEvent|trackTeamAnalyticsEvent|captureImmediate|capture|validateSessionLaunchEvent)\(\s*["']([a-z$][a-z0-9_$]*)["']/g;
// Only inspect analytics payloads: `event: 'change'` can also be a watcher type
// annotation or an unrelated internal message, neither of which reaches PostHog.
const EVENT_KEY = /\b(?:capture(?:Immediate)?\(\s*|invoke\(\s*["']analytics:track["']\s*,\s*)\{[^{}]*?\bevent:\s*["']([a-z$][a-z0-9_$]*)["']/g;

export const TEAM_SCHEMA_FILE = 'packages/electron/src/shared/analytics/teamAnalytics.ts';
export const ALLOW_LIST_FILE = 'packages/electron/src/shared/analytics/posthogIngestAllowList.ts';
export const INIT_CONFIG_FILE = 'packages/electron/src/renderer/index.tsx';

/**
 * `posthog.init` option that turns each SDK-default capture off, for the names
 * in SDK_DISABLED_AT_CLIENT. These have no call site, so nothing else in this
 * gate can see them.
 */
export const INIT_CONFIG_KEY = {
  $pageview: 'capture_pageview',
  $pageleave: 'capture_pageleave',
  $autocapture: 'autocapture',
};

/**
 * Schema maps whose KEYS are event names. These never reach a literal emission
 * seam -- the emitter takes the name as a generic parameter -- so scanning call
 * sites alone silently misses every event they declare.
 *
 * `SEND_WALL_EVENT_SCHEMAS` is why this list is not just the team schema: four
 * live events (`ai_message_submit_attempted`, `composer_state_reported`,
 * `ai_send_blocked`, and `create_ai_session` via its validator) went
 * unclassified and were dropped at ingestion while this gate reported OK.
 */
export const SCHEMA_MAP_FILES = [
  [TEAM_SCHEMA_FILE, 'TEAM_ANALYTICS_EVENT_SCHEMAS'],
  ['packages/electron/src/shared/analytics/sendOutcomes.ts', 'SEND_WALL_EVENT_SCHEMAS'],
];

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

/** Event names declared as keys of the schema maps in SCHEMA_MAP_FILES. */
function schemaMapEvents() {
  const found = new Map();
  for (const [file, constName] of SCHEMA_MAP_FILES) {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    const start = src.indexOf(`export const ${constName}`);
    // A renamed or removed map must not degrade into scanning nothing, which is
    // how a gate goes quiet without anyone noticing.
    if (start === -1) throw new Error(`Could not find ${constName} in ${file}`);
    const body = src.slice(start, src.indexOf('\n} as const', start));
    for (const m of body.matchAll(/^ {2}([a-z][a-z0-9_]*):\s*\{/gm)) {
      if (!found.has(m[1])) found.set(m[1], `${file} (schema key)`);
    }
  }
  return found;
}

/**
 * Parse an `export const NAME = [...]` string-array out of the allow-list module.
 *
 * Anchored on `export const` deliberately. Unanchored, the first mention of a
 * list's name ANYWHERE in the file wins -- including inside a doc comment on a
 * different list -- and `[^=]*=` then runs on to the next declaration, so the
 * parser silently returns some other list's contents. One sentence of prose
 * naming a sibling list was enough to make INTENTIONALLY_DROPPED parse as a
 * one-element array and report ~180 correctly-classified events as unclassified.
 */
export function parseList(src, name) {
  const m = src.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`Could not parse ${name} from ${ALLOW_LIST_FILE}`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

export function collectSourceEventNames(src) {
  return [CALL_SITE, EVENT_KEY].flatMap((re) => {
    re.lastIndex = 0;
    return [...src.matchAll(re)].map((m) => m[1]);
  });
}

/** Every analytics event name reachable from source, mapped to where it was first seen. */
export function collectEventNames() {
  const found = schemaMapEvents();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const src = readFileSync(file, 'utf8');
      const where = relative(repoRoot, file);
      for (const name of collectSourceEventNames(src)) if (!found.has(name)) found.set(name, where);
    }
  }
  return found;
}

/**
 * Pure classification step: returns one message per problem, empty when clean.
 * `found` is a Map of name -> where; `lists` holds the six Sets.
 */
export function findClassificationErrors(found, lists) {
  const { always, sampled, conditional, dropped, sdkOwned, sdkDisabled } = lists;
  const errors = [];

  for (const [name, where] of [...found].sort()) {
    const count = [always, sampled, conditional, dropped, sdkOwned, sdkDisabled].filter((s) =>
      s.has(name),
    ).length;
    if (count === 0) {
      errors.push(
        `  ${name}\n    first seen: ${where}\n` +
          `    -> Not classified. Add it to INGESTED_ALWAYS, INGESTED_SAMPLED,\n` +
          `       INGESTED_CONDITIONALLY or INTENTIONALLY_DROPPED in ${ALLOW_LIST_FILE}.\n` +
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
    conditional: parseList(src, 'INGESTED_CONDITIONALLY'),
    dropped: parseList(src, 'INTENTIONALLY_DROPPED'),
    sdkOwned: parseList(src, 'SDK_OWNED'),
    sdkDisabled: parseList(src, 'SDK_DISABLED_AT_CLIENT'),
  };
}

/**
 * Assert the renderer still switches off every name in SDK_DISABLED_AT_CLIENT.
 *
 * The rest of this gate reasons about names it can find at a call site. These
 * have none -- the SDK emits them from its own defaults -- so the only evidence
 * that they are off is the `posthog.init` config, and the only cost of them
 * coming back on is a bill. `$pageview` alone was 241,643 events in 30 days
 * against a 1M/month free tier.
 *
 * Pure over the config source so a test does not need the real file.
 */
export function checkInitConfigDisables(configSrc, sdkDisabled) {
  const errors = [];
  for (const name of [...sdkDisabled].sort()) {
    const key = INIT_CONFIG_KEY[name];
    if (!key) {
      errors.push(
        `  ${name}\n    -> In SDK_DISABLED_AT_CLIENT but has no entry in INIT_CONFIG_KEY,\n` +
          `       so nothing verifies it is actually off. Add the posthog.init option name.`,
      );
      continue;
    }
    if (!new RegExp(`\\b${key}\\s*:\\s*false\\b`).test(configSrc)) {
      errors.push(
        `  ${name}\n    -> ${INIT_CONFIG_FILE} no longer sets \`${key}: false\`.\n` +
          `       This name is on neither the PostHog allow-list nor any call site, so\n` +
          `       re-enabling capture ships volume that is then discarded at ingestion.\n` +
          `       If you want the data, add ${name} to the 'Cost control allow-list'\n` +
          `       transformation in project 234047 and move it out of SDK_DISABLED_AT_CLIENT.`,
      );
    }
  }
  return errors;
}

function main() {
  const found = collectEventNames();

  if (process.argv.includes('--list')) {
    for (const name of [...found.keys()].sort()) console.log(name);
    return;
  }

  const lists = readLists();
  const errors = [
    ...findClassificationErrors(found, lists),
    ...checkInitConfigDisables(readFileSync(join(repoRoot, INIT_CONFIG_FILE), 'utf8'), lists.sdkDisabled),
  ];

  if (errors.length) {
    console.error(`\nAnalytics allow-list check failed (${errors.length} issue(s)):\n`);
    console.error(errors.join('\n\n'));
    console.error(`\nSee "A server-side allow-list drops unknown events" in docs/POSTHOG_EVENTS.md.\n`);
    process.exit(1);
  }

  console.log(`Analytics allow-list OK - ${found.size} event names, all classified.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
