import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INIT_CONFIG_FILE,
  checkInitConfigDisables,
  collectEventNames,
  collectSourceEventNames,
  findClassificationErrors,
  parseList,
  readLists,
} from '../check-analytics-allowlist.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const sourceEvents = collectEventNames();

const lists = () => {
  const l = readLists();
  return {
    always: new Set(l.always),
    sampled: new Set(l.sampled),
    conditional: new Set(l.conditional),
    dropped: new Set(l.dropped),
    sdkOwned: new Set(l.sdkOwned),
    sdkDisabled: new Set(l.sdkDisabled),
  };
};

test('every event name in source is classified', () => {
  assert.deepEqual(findClassificationErrors(sourceEvents, readLists()), []);
});

test('object captures are detected without treating event parameter types as analytics', () => {
  const src = `
    const publish = (event: 'change' | 'add' | 'unlink') => {};
    const message = { event: 'internal_message' };
    posthog.capture({ distinctId: getId(), event: 'daily_active', properties: {} });
    posthog?.capture({ event: 'session_started' });
    window.electronAPI.invoke('analytics:track', { event: 'session_reparented' });
    sendEvent('clicked_button');
  `;
  assert.deepEqual(collectSourceEventNames(src).sort(), ['clicked_button', 'daily_active', 'session_reparented', 'session_started']);
});

/** Source scan plus one synthetic name, so only that name can be the new error. */
const foundPlus = (name) => {
  const found = new Map(sourceEvents);
  found.set(name, 'some/file.ts');
  return found;
};
const about = (errors, name) => errors.filter((e) => e.includes(name));

test('an unclassified event name fails the check', () => {
  const errors = about(findClassificationErrors(foundPlus('brand_new_event'), readLists()), 'brand_new_event');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /silently dropped at ingestion/);
});

test('a name classified twice fails the check', () => {
  const l = lists();
  l.always.add('double_listed');
  l.dropped.add('double_listed');
  const errors = about(findClassificationErrors(foundPlus('double_listed'), l), 'double_listed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /more than one list/);
});

test('an allow-listed name no longer emitted anywhere fails the check', () => {
  const l = lists();
  l.always.add('deleted_but_still_allow_listed');
  const errors = about(findClassificationErrors(sourceEvents, l), 'deleted_but_still_allow_listed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer emitted/);
});

/**
 * The gate's failure mode is silence, so the thing worth asserting is REACH, not
 * behavior on a synthetic name. Four live events emitted through a schema map or
 * a validator wrapper were invisible to the scan and dropped at ingestion while
 * this gate reported OK. Each seam below is the only one that finds its event.
 */
test('the scan reaches events emitted through wrappers and schema maps', () => {
  const found = new Map(sourceEvents);
  for (const name of [
    'create_ai_session', // validateSessionLaunchEvent(...) wrapper
    'ai_message_submit_attempted', // SEND_WALL_EVENT_SCHEMAS key
    'composer_state_reported', // SEND_WALL_EVENT_SCHEMAS key
    'ai_send_blocked', // SEND_WALL_EVENT_SCHEMAS key
    'daily_active', // capture({ event: '...' }) object literal
  ]) {
    assert.ok(found.has(name), `${name} is emitted in source but the scan missed it`);
  }
});

test('the DAU heartbeat is never sampled', () => {
  // Sampling it would make DAU a scaled estimate again, which is the thing it
  // exists to stop being.
  const { always, sampled } = readLists();
  assert.ok(always.has('daily_active'));
  assert.ok(!sampled.has('daily_active'));
});

/**
 * A doc comment on one list that names a sibling list used to hijack the parse:
 * the unanchored regex matched the prose, ran `[^=]*=` on to the next
 * declaration, and returned that array instead. INTENTIONALLY_DROPPED came back
 * with one element and ~180 correctly-classified events were reported broken.
 */
test('a list name mentioned in a comment does not hijack the parse', () => {
  const src = [
    '/** Unlike INTENTIONALLY_DROPPED, these are kept on a condition. */',
    "export const INGESTED_CONDITIONALLY = ['$set'] as const;",
    "export const INTENTIONALLY_DROPPED = ['alpha', 'beta'] as const;",
  ].join('\n');

  assert.deepEqual([...parseList(src, 'INTENTIONALLY_DROPPED')], ['alpha', 'beta']);
  assert.deepEqual([...parseList(src, 'INGESTED_CONDITIONALLY')], ['$set']);
});

test('$set is conditional, not dropped, because the signup email rides on it', () => {
  const { conditional, dropped } = readLists();
  assert.ok(conditional.has('$set'), '$set is kept when it carries an email');
  assert.ok(!dropped.has('$set'));
});

/**
 * `$pageview` was switched off in `posthog.init` and left off the transformation
 * on the same day, which blanked the saved "Users by Version over Time" insight
 * with no error anywhere. A name with no call site is invisible to every other
 * check here, so the config is the only thing left to assert on.
 */
test('a re-enabled SDK capture fails the check', () => {
  const { sdkDisabled } = readLists();
  assert.ok(sdkDisabled.has('$pageview'));

  const errors = checkInitConfigDisables(
    'capture_pageview: true,\ncapture_pageleave: false,\nautocapture: false,',
    sdkDisabled,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer sets `capture_pageview: false`/);
});

test('the real init config still disables every SDK capture we dropped', () => {
  const { sdkDisabled } = readLists();
  const src = readFileSync(join(repoRoot, INIT_CONFIG_FILE), 'utf8');
  assert.deepEqual(checkInitConfigDisables(src, sdkDisabled), []);
});

test('an SDK-disabled name with no config key to check fails loudly', () => {
  // Adding a name to the list without saying which option turns it off would
  // otherwise produce a list entry that verifies nothing.
  const errors = checkInitConfigDisables('', new Set(['$heatmaps']));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no entry in INIT_CONFIG_KEY/);
});

test('the sampled panel is documented as a fraction that must be scaled', () => {
  // A raw count of a sampled event is wrong by 16/PANEL_BUCKETS.length. If the
  // bucket list changes, the scaling factor in POSTHOG_EVENTS.md changes too.
  const { sampled } = readLists();
  assert.ok(sampled.has('nimbalyst_session_start'), 'session start is sampled, not full-volume');
});
