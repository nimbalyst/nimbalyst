/**
 * V2 `#` reference-picker tests.
 *
 * The `#` typeahead now references an EXISTING tracker item by inserting a
 * TrackerReferenceNode pointer — it must NOT create a frozen inline
 * TrackerItemNode. These tests cover the pure search/build helpers and the
 * Lexical insertion command.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
} from 'lexical';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import {
  buildTrackerReferenceOptions,
  referenceKeyForRecord,
  parseTypeScopedQuery,
  matchTrackerReferenceTrigger,
  $insertTrackerReference,
} from '../trackerReferencePicker';
import {
  TrackerReferenceNode,
  $isTrackerReferenceNode,
  $createTrackerReferenceNode,
} from '../TrackerReferenceNode';
import {
  TrackerItemNode,
  $createTrackerItemNode,
  $getTrackerItemNode,
  $isTrackerItemNode,
} from '../../TrackerPlugin/TrackerItemNode';

function makeRecord(partial: Partial<TrackerRecord> & { id: string }): TrackerRecord {
  return {
    primaryType: 'task',
    typeTags: [],
    source: 'native',
    archived: false,
    syncStatus: 'synced',
    system: {
      workspace: '/ws',
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:00:00.000Z',
    },
    fields: {},
    ...partial,
  };
}

const RECORDS: TrackerRecord[] = [
  makeRecord({
    id: 'rec_login',
    issueKey: 'NIM-13',
    issueNumber: 13,
    primaryType: 'bug',
    fields: { title: 'Fix the login bug', status: 'in-progress' },
  }),
  makeRecord({
    id: 'rec_export',
    issueKey: 'NIM-14',
    issueNumber: 14,
    primaryType: 'task',
    fields: { title: 'Export to CSV', status: 'to-do', description: 'login export path' },
  }),
  makeRecord({
    id: 'rec_archived',
    issueKey: 'NIM-99',
    issueNumber: 99,
    archived: true,
    fields: { title: 'Old archived item', status: 'done' },
  }),
  makeRecord({
    id: 'rec_local',
    // no issueKey — unsynced local item
    fields: { title: 'Local only note' },
  }),
];

describe('referenceKeyForRecord', () => {
  it('prefers the issue key', () => {
    expect(referenceKeyForRecord(RECORDS[0])).toBe('NIM-13');
  });

  it('falls back to the raw record id when there is no issue key', () => {
    expect(referenceKeyForRecord(RECORDS[3])).toBe('rec_local');
  });
});

describe('buildTrackerReferenceOptions', () => {
  it('excludes archived items', () => {
    const opts = buildTrackerReferenceOptions(RECORDS, null);
    expect(opts.some((o) => o.id === 'rec_archived')).toBe(false);
  });

  it('returns newest-first when there is no query', () => {
    const opts = buildTrackerReferenceOptions(RECORDS, null);
    // NIM-14 (issueNumber 14) should rank ahead of NIM-13.
    const i14 = opts.findIndex((o) => o.issueKey === 'NIM-14');
    const i13 = opts.findIndex((o) => o.issueKey === 'NIM-13');
    expect(i14).toBeGreaterThanOrEqual(0);
    expect(i14).toBeLessThan(i13);
  });

  it('matches by issue key', () => {
    const opts = buildTrackerReferenceOptions(RECORDS, 'NIM-13');
    expect(opts[0].issueKey).toBe('NIM-13');
    expect(opts[0].referenceKey).toBe('NIM-13');
  });

  it('matches by title and surfaces live status/type', () => {
    const opts = buildTrackerReferenceOptions(RECORDS, 'login');
    // Both the login bug (title) and CSV export (description) mention login;
    // the title-match should win the ordering.
    expect(opts[0].title).toBe('Fix the login bug');
    expect(opts[0].status).toBe('in-progress');
    expect(opts[0].type).toBe('bug');
  });

  it('restricts to a single type when typeFilter is set', () => {
    const opts = buildTrackerReferenceOptions(RECORDS, null, { typeFilter: 'bug' });
    expect(opts.length).toBe(1);
    expect(opts[0].type).toBe('bug');
    expect(opts[0].issueKey).toBe('NIM-13');
  });

  it('combines type filter with a search query', () => {
    // 'login' appears in the bug title and the task description; scoping to
    // task should drop the bug and keep the CSV export task.
    const opts = buildTrackerReferenceOptions(RECORDS, 'login', { typeFilter: 'task' });
    expect(opts.length).toBe(1);
    expect(opts[0].issueKey).toBe('NIM-14');
  });
});

describe('matchTrackerReferenceTrigger', () => {
  it('matches a bare hash with empty query', () => {
    expect(matchTrackerReferenceTrigger('#')).toEqual({
      matchingString: '',
      replaceableString: '#',
      index: 0,
    });
  });

  it('matches a hyphenated issue key (would span nodes with HashtagPlugin)', () => {
    const m = matchTrackerReferenceTrigger('#NIM-13');
    expect(m?.matchingString).toBe('NIM-13');
    expect(m?.replaceableString).toBe('#NIM-13');
  });

  it('matches a type: scope prefix', () => {
    const m = matchTrackerReferenceTrigger('#bug:login');
    expect(m?.matchingString).toBe('bug:login');
    expect(m?.replaceableString).toBe('#bug:login');
  });

  it('matches the nearest # in accumulated block text', () => {
    const m = matchTrackerReferenceTrigger('see #foo and #bug:');
    expect(m?.matchingString).toBe('bug:');
    expect(m?.replaceableString).toBe('#bug:');
  });

  it('rejects ## (markdown heading)', () => {
    expect(matchTrackerReferenceTrigger('## Heading')).toBeNull();
    expect(matchTrackerReferenceTrigger('##')).toBeNull();
  });

  it('returns null when there is no trigger', () => {
    expect(matchTrackerReferenceTrigger('just text')).toBeNull();
  });
});

describe('parseTypeScopedQuery', () => {
  const known = new Set(['bug', 'task', 'plan']);

  it('extracts a known type prefix and the residual search', () => {
    expect(parseTypeScopedQuery('bug:login', known)).toEqual({
      typeFilter: 'bug',
      searchQuery: 'login',
    });
  });

  it('scopes with an empty residual query (e.g. "#bug:")', () => {
    expect(parseTypeScopedQuery('bug:', known)).toEqual({
      typeFilter: 'bug',
      searchQuery: '',
    });
  });

  it('does not treat an unknown prefix as a type filter', () => {
    expect(parseTypeScopedQuery('foo:bar', known)).toEqual({
      typeFilter: null,
      searchQuery: 'foo:bar',
    });
  });

  it('leaves issue-key queries (no colon) untouched', () => {
    expect(parseTypeScopedQuery('NIM-13', known)).toEqual({
      typeFilter: null,
      searchQuery: 'NIM-13',
    });
  });

  it('handles null query', () => {
    expect(parseTypeScopedQuery(null, known)).toEqual({
      typeFilter: null,
      searchQuery: '',
    });
  });
});

describe('$insertTrackerReference', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    editor = createEditor({
      nodes: [TrackerReferenceNode],
      onError: (e) => {
        throw e;
      },
    });
  });

  it('inserts a TrackerReferenceNode (pointer), not a snapshot', () => {
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('See ');
        paragraph.append(text);
        $getRoot().append(paragraph);
        text.selectEnd();
      },
      { discrete: true },
    );

    editor.update(
      () => {
        const ok = $insertTrackerReference('NIM-13');
        expect(ok).toBe(true);
      },
      { discrete: true },
    );

    let found: TrackerReferenceNode | null = null;
    editor.read(() => {
      const walk = (node: ReturnType<typeof $getRoot>) => {
        for (const child of node.getChildren?.() ?? []) {
          if ($isTrackerReferenceNode(child)) {
            found = child;
          } else if ('getChildren' in child) {
            // @ts-expect-error recursive element walk
            walk(child);
          }
        }
      };
      walk($getRoot());
    });

    expect(found).not.toBeNull();
    expect(found!.getReferenceKey()).toBe('NIM-13');
  });
});

describe('convert legacy inline tracker -> reference (node swap)', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    editor = createEditor({
      nodes: [TrackerItemNode, TrackerReferenceNode],
      onError: (e) => {
        throw e;
      },
    });
  });

  it('replaces a TrackerItemNode in place with a TrackerReferenceNode', () => {
    let itemKey = '';
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const item = $createTrackerItemNode({
          id: 'bug_local1',
          type: 'bug',
          title: 'Frozen inline bug',
          status: 'to-do',
        });
        item.append($createTextNode('Frozen inline bug'));
        paragraph.append(item);
        $getRoot().append(paragraph);
        itemKey = item.getKey();
      },
      { discrete: true },
    );

    // The conversion node-swap performed by handleConvertToReference once the
    // host has allocated a real item (issue key NIM-50).
    editor.update(
      () => {
        const node = $getTrackerItemNode(itemKey);
        expect(node).not.toBeNull();
        node!.replace($createTrackerReferenceNode('NIM-50'));
      },
      { discrete: true },
    );

    let refCount = 0;
    let itemCount = 0;
    let refKey: string | null = null;
    editor.read(() => {
      const map = editor.getEditorState()._nodeMap;
      for (const [, node] of map) {
        if ($isTrackerReferenceNode(node)) {
          refCount++;
          refKey = node.getReferenceKey();
        }
        if ($isTrackerItemNode(node)) itemCount++;
      }
    });

    expect(itemCount).toBe(0);
    expect(refCount).toBe(1);
    expect(refKey).toBe('NIM-50');
  });
});
