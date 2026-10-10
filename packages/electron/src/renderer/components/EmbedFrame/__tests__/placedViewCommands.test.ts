// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildPlacedViewCommandEntries } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/placedViewCommandEntries';
import { placedViewReachForDocument, placedViewScopeForDocument } from '../placedViewCommands';

function model(type: string, plural: string, fields: TrackerDataModel['fields']): TrackerDataModel {
  return { type, displayName: type, displayNamePlural: plural, fields } as TrackerDataModel;
}

describe('buildPlacedViewCommandEntries', () => {
  it('offers a board grouped by status, falling back to the first single-select', () => {
    const commands = buildPlacedViewCommandEntries([
      model('work', 'Work', [{ name: 'tier', type: 'select' }, { name: 'status', type: 'select' }]),
      model('company', 'Companies', [{ name: 'tags', type: 'select', multiValue: true }, { name: 'tier', type: 'select' }]),
    ]);
    expect(commands.filter(command => command.title.startsWith('Board:')).map(command => command.payload)).toEqual([
      { target: { kind: 'type', typeId: 'work' }, label: 'Work', attrs: { mode: 'board', group: 'status', ordering: 'manual' } },
      { target: { kind: 'type', typeId: 'company' }, label: 'Companies', attrs: { mode: 'board', group: 'tier', ordering: 'manual' } },
    ]);
  });

  it('offers a chart counted by the board grouping, else a person, else a date', () => {
    const commands = buildPlacedViewCommandEntries([
      model('work', 'Work', [{ name: 'due', type: 'date' }, { name: 'status', type: 'select' }]),
      model('note', 'Notes', [{ name: 'due', type: 'date' }, { name: 'owner', type: 'user' }]),
      model('event', 'Events', [{ name: 'tags', type: 'select', multiValue: true }, { name: 'when', type: 'datetime' }]),
    ]);
    expect(commands.filter(command => command.title.startsWith('Chart:')).map(command => [command.title, (command.payload as { attrs: unknown }).attrs])).toEqual([
      ['Chart: Work', { mode: 'chart', chart: 'bar', by: 'status' }],
      ['Chart: Notes', { mode: 'chart', chart: 'bar', by: 'owner' }],
      ['Chart: Events', { mode: 'chart', chart: 'bar', by: 'when' }],
    ]);
  });

  it('offers a table per type, a 2x2 for types with two number fields, and the marks lists', () => {
    const commands = buildPlacedViewCommandEntries([
      model('competitor', 'Competitors', [
        { name: 'title', type: 'string' },
        { name: 'devFirst', type: 'number' },
        { name: 'realtime', type: 'number' },
      ]),
      model('module', 'Modules', [{ name: 'title', type: 'string' }, { name: 'size', type: 'number' }]),
    ]);
    expect(commands.map((command) => [command.title, command.payload])).toEqual([
      ['Table: Competitors', { target: { kind: 'type', typeId: 'competitor' }, label: 'Competitors' }],
      ['2x2: Competitors', {
        target: { kind: 'type', typeId: 'competitor' },
        label: 'Competitors',
        attrs: { mode: '2x2', x: 'devFirst', y: 'realtime' },
      }],
      ['Table: Modules', { target: { kind: 'type', typeId: 'module' }, label: 'Modules' }],
      ['Decisions list', { target: { kind: 'marks', marks: 'decided' }, label: 'Decisions' }],
      ['Open questions list', { target: { kind: 'marks', marks: 'open' }, label: 'Open questions' }],
    ]);
  });
});

describe('placedViewScopeForDocument', () => {
  const team = { orgId: 'org-1', projectId: 'tp-1' };
  const lanes = { itemLane: (id: string) => (id === 'team-item' ? 'team' as const : 'personal' as const), typeLane: (id: string) => (id === 'module' ? 'team' as const : 'personal' as const) };

  it('names the page\'s own scope: team pages the team project, Personal pages and files local', () => {
    expect(placedViewScopeForDocument('collab://org:o:doc:d1', { team, ...lanes })).toEqual(team);
    expect(placedViewScopeForDocument('personal://doc-1', { team, ...lanes })).toBe('local');
    expect(placedViewScopeForDocument('tracker://team-item', { team, ...lanes })).toEqual(team);
    expect(placedViewScopeForDocument('tracker://mine', { team, ...lanes })).toBe('local');
    expect(placedViewScopeForDocument('type://module', { team, ...lanes })).toEqual(team);
    expect(placedViewScopeForDocument('/repo/notes/landscape.md', { team, ...lanes })).toBe('local');
  });

  it('writes no scope it cannot name', () => {
    expect(placedViewScopeForDocument(null, { team, ...lanes })).toBeUndefined();
    expect(placedViewScopeForDocument('collab://org:o:doc:d1', { team: null, ...lanes })).toBeUndefined();
  });
});

describe('placedViewReachForDocument', () => {
  const team = { orgId: 'org-1', projectId: 'tp-1' };
  const lanes = { itemLane: () => 'personal' as const, typeLane: () => 'personal' as const };

  it('reaches the window team, and local only on a page of the author\'s own', () => {
    expect(placedViewReachForDocument('collab://org:o:doc:d1', { team, ...lanes })).toEqual({ team, local: false });
    expect(placedViewReachForDocument('personal://doc-1', { team, ...lanes })).toEqual({ team, local: true });
    expect(placedViewReachForDocument(null, { team, ...lanes })).toEqual({ team, local: false });
    expect(placedViewReachForDocument(null, { team: null, ...lanes })).toEqual({ team: null, local: true });
  });
});
