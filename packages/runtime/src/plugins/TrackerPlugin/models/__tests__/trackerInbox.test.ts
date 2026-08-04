// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { loadBuiltinTrackers } from '../ModelLoader';
import { globalRegistry, type TrackerDataModel } from '../TrackerDataModel';
import { getRecordPriority, getRecordStatus, getFieldByRole } from '../../trackerRecordAccessors';
import { COLLECTION_INVERSE_KEY } from '../trackerCollections';
import {
  acceptStatusFor,
  countInboxItems,
  getDefaultPriority,
  getInitialStatus,
  isAgentProposal,
  isUntriaged,
  priorityOptionsFor,
  selectInboxItems,
  triageSignals,
  STAMPED_DEFAULT_PRIORITY,
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
      markedTriaged: false,
    });
  });

  // NIM-2172: every write path stamps `priority || 'medium'` at create, so
  // reading any priority as a decision emptied the inbox permanently.
  it('does not treat the stamped default priority as a triage act', () => {
    const stamped = record('stamped', 'bug', { priority: STAMPED_DEFAULT_PRIORITY });
    expect(triageSignals(stamped, signals).prioritized).toBe(false);
    expect(isUntriaged(stamped, signals)).toBe(true);

    // Any other value is a human choosing, including one below the default.
    expect(isUntriaged(record('chosen-low', 'bug', { priority: 'low' }), signals)).toBe(false);
    expect(isUntriaged(record('chosen-high', 'bug', { priority: 'high' }), signals)).toBe(false);
  });

  it('falls back to the stamped default for a type that declares none', () => {
    // A type with no declared priority default is still receiving the stamp on
    // create, so the stamp is its de-facto default.
    expect(getDefaultPriority('bug')).toBe('medium');
    expect(getDefaultPriority('not-a-registered-type')).toBe(STAMPED_DEFAULT_PRIORITY);
    const custom = record('custom-stamped', 'not-a-registered-type', { priority: 'medium' });
    expect(triageSignals(custom, signals).prioritized).toBe(false);
  });

  it('honors a type whose declared priority default is not medium', () => {
    const type = 'p0-first';
    const model: TrackerDataModel = {
      type,
      displayName: 'Ticket',
      displayNamePlural: 'Tickets',
      icon: 'route',
      color: '#000000',
      modes: { inline: true, fullDocument: false },
      idPrefix: 'P0F',
      idFormat: 'ulid',
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'severity',
          type: 'select',
          default: 'p3',
          options: [
            { value: 'p1', label: 'P1' },
            { value: 'p2', label: 'P2' },
            { value: 'p3', label: 'P3' },
          ],
        },
      ],
      roles: { title: 'title', priority: 'severity' },
    };
    globalRegistry.register(model);
    try {
      expect(getDefaultPriority(type)).toBe('p3');
      expect(isUntriaged(record('at-default', type, { severity: 'p3' }), signals)).toBe(true);
      expect(isUntriaged(record('escalated', type, { severity: 'p1' }), signals)).toBe(false);
    } finally {
      globalRegistry.unregister(type);
    }
  });

  it('retires an item that a person explicitly left alone', () => {
    const left = record('left-alone', 'bug', {}, {
      system: {
        workspace: '/w',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        triagedAt: '2026-07-25T00:00:00.000Z',
      },
    });
    expect(triageSignals(left, signals).markedTriaged).toBe(true);
    expect(isUntriaged(left, signals)).toBe(false);
    // Clearing the mark returns it to the queue.
    expect(isUntriaged(record('not-left', 'bug'), signals)).toBe(true);
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
