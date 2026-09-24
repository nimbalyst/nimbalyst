import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkSettingsSearchIndex,
  findMissingAnchors,
  findUncoveredRows,
  parseAnchors,
  parseExcluded,
  parseSettingRows,
  parseTestIds,
} from '../check-settings-search-index.mjs';

test('every search entry and exclusion points at a row that exists', () => {
  assert.deepEqual(checkSettingsSearchIndex().missingAnchors, []);
});

test('every settings row is searchable or explicitly excluded', () => {
  assert.deepEqual(checkSettingsSearchIndex().uncoveredRows, []);
});

test('reads anchors, exclusions and test ids in every literal form', () => {
  assert.deepEqual(parseAnchors(`{ anchor: 'row-a', name: 'A' },\n{ anchor:'row-b' }`), ['row-a', 'row-b']);
  assert.deepEqual(
    parseExcluded(`export const SETTINGS_SEARCH_EXCLUDED: Record<string, string> = {\n  'dev-row': 'Development builds only.',\n};`),
    ['dev-row'],
  );
  const ids = parseTestIds(`<div data-testid="x" /><T testId="y" /><div data-testid={'z'} /><T testId={dynamic} />`);
  assert.deepEqual([...ids].sort(), ['x', 'y', 'z']);
});

test('reports an anchor whose row is gone', () => {
  assert.deepEqual(findMissingAnchors(['kept', 'removed'], new Set(['kept'])), ['removed']);
});

test('flags a new settings row that nobody listed, and one with no test id', () => {
  const src = [
    '<SettingsToggle name="Listed" testId="listed" />',
    '<SettingsToggle name="Excluded" testId="excluded" />',
    '<SettingsToggle name="Forgotten" testId="forgotten" />',
    '<DropdownRow name="No id" options={[]} />',
    // Built at runtime: the check cannot know the id, so it is skipped.
    '<SettingsToggle name={feature.name} testId={`alpha-${feature.tag}`} />',
  ].join('\n');
  const rows = parseSettingRows(src, 'Panel.tsx');
  assert.deepEqual(
    findUncoveredRows(rows, new Set(['listed']), new Set(['excluded'])).map((r) => r.problem),
    ['Panel.tsx:3 "Forgotten" (testId "forgotten") is not in the search list', 'Panel.tsx:4 "No id" has no testId'],
  );
});
