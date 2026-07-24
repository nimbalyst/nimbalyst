import { describe, it, expect, beforeAll } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { loadBuiltinTrackers } from '../ModelLoader';
import { globalRegistry, type TrackerDataModel } from '../TrackerDataModel';
import { getRecordPriority, getRecordStatus, getFieldByRole } from '../../trackerRecordAccessors';
import { COLLECTION_INVERSE_KEY } from '../trackerCollections';
import {
  acceptStatusFor,
  countInboxItems,
  getInitialStatus,
  isAgentProposal,
  isUntriaged,
  priorityOptionsFor,
  selectInboxItems,
  triageSignals,
  type InboxSignals,
} from '../trackerInbox';

beforeAll(() => {
  loadBuiltinTrackers();
});

const signals: InboxSignals = {
  getStatus: getRecordStatus,
  getPriority: getRecordPriority,
  getAssignee: (record) => getFieldByRole(record, 'assignee'),
};

function record(
  id: string,
  primaryType = 'bug',
  fields: Record<string, unknown> = {},
  overrides: Partial<TrackerRecord> = {},
): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
    fields: { title: `Item ${id}`, status: getInitialStatus(primaryType), ...fields },
    ...overrides,
  } as TrackerRecord;
}

describe('trackerInbox', () => {
  it('treats a freshly-filed bug as untriaged', () => {
    expect(isUntriaged(record('fresh'), signals)).toBe(true);
  });

  it('retires an item from the inbox on any single triage act', () => {
    expect(isUntriaged(record('assigned', 'bug', { owner: 'me@example.com' }), signals)).toBe(false);
    expect(isUntriaged(record('prioritized', 'bug', { priority: 'high' }), signals)).toBe(false);
    expect(isUntriaged(record('working', 'bug', { status: 'in-progress' }), signals)).toBe(false);
    expect(isUntriaged(
      record('collected', 'bug', {
        collection: [{ itemId: 'm1', direction: 'in', relationshipTypeKey: COLLECTION_INVERSE_KEY }],
      }),
      signals,
    )).toBe(false);
  });

  it('reports which act triaged an item', () => {
    const item = record('mixed', 'bug', { priority: 'low', status: 'in-review' });
    expect(triageSignals(item, signals)).toEqual({
      assigned: false,
      prioritized: true,
      inCollection: false,
      statusMoved: true,
    });
  });

  it('keeps archived items and collections themselves out of the inbox', () => {
    expect(isUntriaged(record('dismissed', 'bug', {}, { archived: true }), signals)).toBe(false);
    expect(isUntriaged(record('sprint-7', 'milestone'), signals)).toBe(false);
  });

  it('does not read status as triage when the type declares no default', () => {
    // A type whose status field has no default can't distinguish "untouched"
    // from "moved", so the other signals must decide.
    const unknownType = record('custom', 'not-a-registered-type', { status: 'whatever' });
    expect(getInitialStatus('not-a-registered-type')).toBe('');
    expect(triageSignals(unknownType, signals).statusMoved).toBe(false);
    expect(isUntriaged(unknownType, signals)).toBe(true);
  });

  it('orders the queue newest-first and honors personal snoozes', () => {
    const older = record('older');
    const newer = record('newer', 'bug', {}, {
      system: { workspace: '/w', createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z' },
    });
    const snoozed = record('snoozed');
    const nowMs = Date.UTC(2026, 6, 23);

    const queue = selectInboxItems([older, newer, snoozed], {
      ...signals,
      nowMs,
      snoozedUntilByItemId: new Map([['snoozed', nowMs + 60_000]]),
    });
    expect(queue.map((i) => i.id)).toEqual(['newer', 'older']);

    // An expired snooze returns the item to the queue.
    const afterSnooze = selectInboxItems([snoozed], {
      ...signals,
      nowMs,
      snoozedUntilByItemId: new Map([['snoozed', nowMs - 1]]),
    });
    expect(afterSnooze.map((i) => i.id)).toEqual(['snoozed']);
  });

  it('scopes the inbox to one type on request', () => {
    const items = [record('bug-1', 'bug'), record('task-1', 'task')];
    expect(selectInboxItems(items, { ...signals, scope: 'global' })).toHaveLength(2);
    expect(selectInboxItems(items, { ...signals, scope: 'type', selectedType: 'task' })
      .map((i) => i.id)).toEqual(['task-1']);
    // `all` in the type slot means the scope toggle has nothing to narrow to.
    expect(selectInboxItems(items, { ...signals, scope: 'type', selectedType: 'all' })).toHaveLength(2);
  });

  it('counts the same set the queue renders', () => {
    const items = [record('a'), record('b', 'bug', { priority: 'high' }), record('c', 'task')];
    expect(countInboxItems(items, signals)).toBe(selectInboxItems(items, signals).length);
    expect(countInboxItems(items, signals)).toBe(2);
  });

  it('accepts an item into the status after its initial one', () => {
    expect(getInitialStatus('bug')).toBe('to-do');
    expect(acceptStatusFor('bug')).toBe('in-progress');
    // Accepting must actually retire the item from the inbox.
    const accepted = record('accepted', 'bug', { status: acceptStatusFor('bug')! });
    expect(isUntriaged(accepted, signals)).toBe(false);
  });

  it('uses the first lifecycle option as the initial status when no default is declared', () => {
    const type = 'no-default-lifecycle';
    const model: TrackerDataModel = {
      type,
      displayName: 'Lifecycle item',
      displayNamePlural: 'Lifecycle items',
      icon: 'route',
      color: '#000000',
      modes: { inline: true, fullDocument: false },
      idPrefix: 'NDL',
      idFormat: 'ulid',
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'phase',
          type: 'select',
          options: [
            { value: 'new', label: 'New' },
            { value: 'active', label: 'Active' },
          ],
        },
      ],
      roles: { title: 'title', workflowStatus: 'phase' },
    };
    globalRegistry.register(model);
    try {
      expect(getInitialStatus(type)).toBe('new');
      expect(acceptStatusFor(type)).toBe('active');
      expect(isUntriaged(record('accepted-custom', type, { phase: 'active' }), signals)).toBe(false);
    } finally {
      globalRegistry.unregister(type);
    }
  });

  it('has no accept status for an unknown type', () => {
    expect(acceptStatusFor('not-a-registered-type')).toBeNull();
  });

  it('offers the type\'s own priority values', () => {
    expect(priorityOptionsFor('bug')).toEqual(['low', 'medium', 'high', 'critical']);
    expect(priorityOptionsFor('not-a-registered-type')).toEqual([]);
  });

  it('flags agent-filed items as proposals', () => {
    expect(isAgentProposal(record('mine'))).toBe(false);
    expect(isAgentProposal(record('agent', 'bug', {}, {
      system: { workspace: '/w', createdAt: '', updatedAt: '', createdByAgent: true },
    }))).toBe(true);
  });
});
