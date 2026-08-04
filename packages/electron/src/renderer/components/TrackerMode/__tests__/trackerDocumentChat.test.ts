/**
 * The tracker document view's chat panel is the ordinary chat panel: opening it
 * next to an item must NOT mint a conversation about the item. The item only
 * contributes document context, the way a collaborative document does.
 */
import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { SessionMeta } from '../../../store/atoms/sessions';
import {
  buildTrackerDocumentContext,
  resolveTrackerChatSessionId,
  trackerContextItemId,
} from '../trackerDocumentChat';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...overrides,
  } as SessionMeta;
}

function registryOf(...sessions: SessionMeta[]): Map<string, SessionMeta> {
  return new Map(sessions.map((entry) => [entry.id, entry]));
}

function record(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'item-1',
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: 'NIM-9',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/ws',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
    fields: { title: 'Body never paints', status: 'in-progress', priority: 'high' },
    ...overrides,
  } as TrackerRecord;
}

describe('resolveTrackerChatSessionId', () => {
  it('shows the session the user explicitly opened for this item', () => {
    const paired = session('chat-1');

    expect(resolveTrackerChatSessionId({
      pairedSessionId: 'chat-1',
      sessionRegistry: registryOf(paired),
    })).toBe('chat-1');
  });

  it('leaves session choice to the standard sidebar when nothing was opened', () => {
    expect(resolveTrackerChatSessionId({
      pairedSessionId: null,
      sessionRegistry: registryOf(session('chat-1')),
    })).toBeNull();
  });

  it('does not resurrect a deleted session', () => {
    expect(resolveTrackerChatSessionId({
      pairedSessionId: 'gone',
      sessionRegistry: registryOf(session('chat-1')),
    })).toBeNull();
  });
});

describe('buildTrackerDocumentContext', () => {
  it('passes the backing file as the context path, like an open document', () => {
    const context = buildTrackerDocumentContext('item-1', record({
      system: {
        workspace: '/ws',
        documentPath: 'plans/body.md',
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
    } as Partial<TrackerRecord>));

    expect(context.filePath).toBe('plans/body.md');
    expect(context.editorContextItems?.[0].description).toContain('plans/body.md');
  });

  it('points a database-only item at the tracker tools, with no file path', () => {
    const context = buildTrackerDocumentContext('item-1', record());

    expect(context.filePath).toBeUndefined();
    expect(context.editorContextItems?.[0].description)
      .toContain('tracker_get id "NIM-9"');
  });

  it('describes the item as one dismissible chip carrying its state', () => {
    const items = buildTrackerDocumentContext('item-1', record()).editorContextItems ?? [];

    expect(items.length).toBe(1);
    expect(items[0].id).toBe(trackerContextItemId('item-1'));
    expect(items[0].label).toBe('NIM-9 Body never paints');
    expect(items[0].description).toContain('type: bug');
    expect(items[0].description).toContain('status: in-progress');
    expect(items[0].description).toContain('priority: high');
  });

  it('degrades to the raw id when the record has not loaded yet', () => {
    const context = buildTrackerDocumentContext('item-1', null);

    expect(context.filePath).toBeUndefined();
    expect(context.editorContextItems?.[0].label).toBe('item-1');
  });
});
