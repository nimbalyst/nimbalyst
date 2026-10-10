// @vitest-environment node
/**
 * A browser-created item's description becomes its collaborative body, the
 * same document a desktop would have written, instead of a `description`
 * field no editor reads.
 */
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { lexicalYDocToMarkdown, markdownToLexicalYUpdate } from '@nimbalyst/runtime/sync/markdownYDoc';
import { createFakeServer } from '../../../../tracker-engine/src/__tests__/fakeTrackerServer';
import { BrowserTrackerDataSource } from '../browser/BrowserTrackerDataSource';
import { readDocumentRoomMarkdown, seedTrackerBody } from '../body';
import type { TrackerBodyRoom } from '../body';

class FakeBodyRoom implements TrackerBodyRoom {
  readonly doc = new Y.Doc();
  acknowledged: Uint8Array | null = null;
  destroyed = false;
  private synced = false;
  private readonly listeners = new Set<(status: 'connected') => void>();

  constructor(serverState?: Uint8Array) {
    if (serverState) Y.applyUpdate(this.doc, serverState);
  }

  getYDoc(): Y.Doc { return this.doc; }
  async connect(): Promise<void> {
    queueMicrotask(() => {
      this.synced = true;
      for (const listener of this.listeners) listener('connected');
    });
  }
  isSynced(): boolean { return this.synced; }
  hasUndecodedContent(): boolean { return false; }
  onStatusChange(listener: (status: 'connected') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async flushWithAck(): Promise<boolean> {
    this.acknowledged = Y.encodeStateAsUpdate(this.doc);
    return true;
  }
  destroy(): void { this.destroyed = true; }
}

const sources: BrowserTrackerDataSource[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.dispose();
});

function createSource(
  openTrackerBodyRoom: (documentId: string) => TrackerBodyRoom,
  seeder: typeof seedTrackerBody | null = seedTrackerBody,
) {
  const server = createFakeServer();
  const source = new BrowserTrackerDataSource({
    workspacePath: '/browser/team-project',
    serverUrl: 'ws://fake',
    orgId: 'org-test',
    teamProjectId: 'project-test',
    teamMemberId: asTeamMemberId('member-body'),
    currentUser: { displayName: 'Browser member', email: 'b@example.com', gitName: null, gitEmail: null },
    presenceIdentity: { displayName: 'Browser member', avatarUrl: null },
    getTeamJwt: async () => asTeamJwt('team-jwt'),
    authorizeRoom: async () => null,
    databaseName: `browser-tracker-create-body-${crypto.randomUUID()}`,
    indexedDbFactory: fakeIndexedDB,
    createWebSocket: server.connect,
    openTrackerBodyRoom,
    ...(seeder ? { seedTrackerBody: seeder } : {}),
  });
  sources.push(source);
  return source;
}

async function authorized(source: BrowserTrackerDataSource): Promise<void> {
  await vi.waitFor(() => expect(source.status().status).toBe('connected'));
}

function item(id: string, description?: string) {
  return {
    id,
    type: 'bug',
    title: 'Crash on save',
    status: 'to-do',
    priority: 'high',
    workspace: '/browser/team-project',
    sharing: 'team' as const,
    ...(description === undefined ? {} : { description }),
  };
}

async function storedPayload(source: BrowserTrackerDataSource, itemId: string) {
  const persistence = (source as unknown as { persistence: { getItem(id: string): Promise<{ payload: any } | null> } }).persistence;
  return (await persistence.getItem(itemId))?.payload;
}

describe('BrowserTrackerDataSource create-item body', () => {
  it('seeds the body room from the description and publishes bodyVersion 1', async () => {
    const rooms = new Map<string, FakeBodyRoom>();
    const source = createSource((documentId) => {
      const room = new FakeBodyRoom();
      rooms.set(documentId, room);
      return room;
    });
    await authorized(source);

    await source.command({ type: 'create-item', item: item('item-1', '## Steps\n\n- open a doc\n- press save') });

    const room = rooms.get('tracker-content/item-1');
    expect(room?.destroyed).toBe(true);
    expect(lexicalYDocToMarkdown(room!.acknowledged!).trim()).toBe('## Steps\n\n- open a doc\n- press save');
    const payload = await storedPayload(source, 'item-1');
    expect(payload.bodyVersion).toBe(1);
    expect(payload.fields).not.toHaveProperty('description');

    await source.command({ type: 'create-item', item: item('item-2') });
    expect(rooms.has('tracker-content/item-2')).toBe(false);
    expect((await storedPayload(source, 'item-2')).bodyVersion).toBe(0);
  });

  it('refuses to overwrite a body room that already has other content', async () => {
    const room = new FakeBodyRoom(markdownToLexicalYUpdate('Someone else wrote this.'));
    const source = createSource(() => room);
    await authorized(source);

    await expect(
      source.command({ type: 'create-item', item: item('item-3', 'My description') }),
    ).rejects.toThrow(/already has edits/);
    expect(lexicalYDocToMarkdown(Y.encodeStateAsUpdate(room.doc)).trim()).toBe('Someone else wrote this.');
    expect(room.destroyed).toBe(true);
    expect(await storedPayload(source, 'item-3')).toBeUndefined();
  });

  it('rejects a create with a body when the host injected no seeder', async () => {
    const openRoom = vi.fn(() => new FakeBodyRoom());
    const source = createSource(openRoom, null);
    await authorized(source);

    await expect(
      source.command({ type: 'create-item', item: item('item-4', 'My description') }),
    ).rejects.toThrow(/cannot write item bodies/);
    expect(openRoom).not.toHaveBeenCalled();
    expect(await storedPayload(source, 'item-4')).toBeUndefined();
  });
});

describe('readDocumentRoomMarkdown', () => {
  it('reads a room back as the markdown that was written, and closes it', async () => {
    const written = new FakeBodyRoom();
    await seedTrackerBody(written, '# Plan\n\nShip it.');
    const room = new FakeBodyRoom(written.acknowledged!);
    expect((await readDocumentRoomMarkdown(room)).trim()).toBe('# Plan\n\nShip it.');
    expect(room.destroyed).toBe(true);
    expect(await readDocumentRoomMarkdown(new FakeBodyRoom())).toBe('');
  });

  it('refuses a room it cannot decode rather than reading it as empty', async () => {
    const room = new FakeBodyRoom();
    room.hasUndecodedContent = () => true;
    await expect(readDocumentRoomMarkdown(room)).rejects.toThrow(/cannot read/);
    expect(room.destroyed).toBe(true);
  });
});
