import { describe, expect, it } from 'vitest';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { buildTrackerNavigationTree } from '../trackerNavigationTree';

const model = (type: string): TrackerDataModel => ({
  type,
  displayName: type,
  displayNamePlural: `${type}s`,
  icon: 'check',
  color: '#000',
  modes: { inline: true, fullDocument: false },
  idPrefix: type.toUpperCase(),
  idFormat: 'uuid',
  fields: [],
});

describe('buildTrackerNavigationTree', () => {
  it('files built-in and custom types, preserves manual order, and leaves each type exactly once', () => {
    const tree = buildTrackerNavigationTree([model('bug'), model('custom'), model('task')], [
      { entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0' },
      { entryId: 'type:task', kind: 'type-placement', trackerType: 'task', folderId: 'delivery', sortKey: 'a1' },
      { entryId: 'type:custom', kind: 'type-placement', trackerType: 'custom', folderId: 'delivery', sortKey: 'a0' },
      { entryId: 'type:bug', kind: 'type-placement', trackerType: 'bug', folderId: null, sortKey: 'a0' },
    ]);
    expect(tree.folders[0].trackerTypes.map((row) => row.tracker.type)).toEqual(['custom', 'task']);
    expect(tree.rootTypes.map((row) => row.tracker.type)).toEqual(['bug']);
  });

  it('projects missing folder references and missing placements safely at root', () => {
    const tree = buildTrackerNavigationTree([model('bug'), model('task')], [
      { entryId: 'type:task', kind: 'type-placement', trackerType: 'task', folderId: 'gone', sortKey: 'a0' },
    ]);
    expect(tree.folders).toEqual([]);
    expect(new Set(tree.rootTypes.map((row) => row.tracker.type))).toEqual(new Set(['bug', 'task']));
  });
});
