// @vitest-environment node

/**
 * The predicate registry rides the team schema lane under `__predicates__`
 * (NIM-6653). Until this lane existed nothing published it. `.nimbalyst/` is
 * gitignored, so the registry existed only on the machine that wrote it: no
 * teammate and no web console could read it.
 *
 * These run two desktop lanes against the in-memory TrackerRoom fake over real
 * `TrackerSyncEngine`s, each on its own temp `.nimbalyst/predicates.yaml`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { asTeamJwt, asTeamMemberId } from '@nimbalyst/collab-protocol';
import {
  InMemoryTrackerPersistence,
  TrackerSyncEngine,
  type TrackerSchemaSyncHooks,
} from '@nimbalyst/tracker-engine';
import type { LabelRegistry, PredicateDefinition } from '@nimbalyst/tracker-schema';
import {
  decodeTrackerSchemaPayload,
  encodeTrackerLabelRegistryPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import { canonicalLabelRegistryJson } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/labelRegistryMerge';
import {
  canonicalPredicateRegistryJson,
  mergePredicateRegistries,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/predicateRegistryMerge';
import { createFakeServer, type FakeTrackerRoom } from '../../../../../../tracker-engine/src/__tests__/fakeTrackerServer';
import {
  readWorkspacePredicateRegistry,
  writeWorkspacePredicateRegistry,
} from '../trackerPredicateRegistryFile';
import {
  createInMemoryPredicateRegistrySyncStateStore,
  listUnsyncedPredicateRegistry,
  type PredicateRegistrySyncStateStore,
} from '../trackerPredicateRegistrySync';
import { readWorkspaceLabelRegistry, writeWorkspaceLabelRegistry } from '../trackerLabelRegistryFile';
import {
  applyRemoteLabelRegistry,
  createInMemoryLabelRegistrySyncStateStore,
  listUnsyncedLabelRegistry,
} from '../trackerLabelRegistrySync';
import { composeTrackerSchemaSyncHooks } from '../trackerSchemaSyncHooks';
import { registerTrackerSchemaFlushHandler } from '../trackerSchemaFlush';

const worksAt: PredicateDefinition = {
  id: 'works-at',
  label: 'works at',
  inverseLabel: 'employs',
  subjectKinds: ['*'],
  valueShape: 'entity',
  direction: 'directed',
};
const competesWith: PredicateDefinition = {
  id: 'competes-with',
  label: 'competes with',
  subjectKinds: ['*'],
  valueShape: 'entity',
  direction: 'symmetric',
};

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/** Type definitions are not under test: an empty type-def lane. */
const noTypeDefs: TrackerSchemaSyncHooks = {
  listUnsynced: async () => [],
  applyRemote: async () => undefined,
  markRejected: async () => undefined,
};

interface Peer {
  workspacePath: string;
  engine: TrackerSyncEngine;
  state: PredicateRegistrySyncStateStore;
  applied: PredicateDefinition[][];
  appliedLabels: LabelRegistry[];
}

function predicatesRow(room: FakeTrackerRoom) {
  return room.getStoredSchemas().find(s => s.schemaType === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE);
}

describe('predicate registry on the team schema lane (NIM-6653)', () => {
  let tmp: string;
  const peers: Peer[] = [];
  const unregister: Array<() => void> = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-predicates-'));
  });

  afterEach(() => {
    for (const peer of peers.splice(0)) peer.engine.destroy();
    for (const fn of unregister.splice(0)) fn();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function connectPeer(name: string, server: ReturnType<typeof createFakeServer>): Promise<Peer> {
    const workspacePath = path.join(tmp, name);
    fs.mkdirSync(workspacePath, { recursive: true });
    const state = createInMemoryPredicateRegistrySyncStateStore();
    const applied: PredicateDefinition[][] = [];
    const appliedLabels: LabelRegistry[] = [];
    const engine = new TrackerSyncEngine({
      serverUrl: 'ws://fake',
      orgId: 'test-org',
      teamProjectId: 'tracker-test-project',
      teamMemberId: asTeamMemberId(`member-${name}`),
      persistence: new InMemoryTrackerPersistence(),
      schemaSync: composeTrackerSchemaSyncHooks(workspacePath, noTypeDefs, {
        state,
        onApplied: (_ws, predicates) => { applied.push(predicates); },
      }, {
        state: createInMemoryLabelRegistrySyncStateStore(),
        onApplied: (_ws, registry) => { appliedLabels.push(registry); },
      }),
      getJwt: async () => asTeamJwt('fake-jwt'),
      createWebSocket: () => server.connect(),
    });
    const peer = { workspacePath, engine, state, applied, appliedLabels };
    peers.push(peer);
    await engine.connect();
    await waitUntil(() => engine.getStatus() === 'connected');
    return peer;
  }

  it('publishes a registry saved while connected, and a second peer decodes it', async () => {
    const server = createFakeServer();
    const a = await connectPeer('a', server);
    const b = await connectPeer('b', server);
    // What TrackerSyncManager registers: route a flush to the workspace's engine.
    unregister.push(registerTrackerSchemaFlushHandler((ws) =>
      peers.find(p => p.workspacePath === ws)?.engine.flushSchemas()));

    await writeWorkspacePredicateRegistry(a.workspacePath, [worksAt, competesWith]);

    await waitUntil(() => predicatesRow(server.room) !== undefined);
    const row = predicatesRow(server.room)!;
    const decoded = decodeTrackerSchemaPayload(row.schemaType, row.encryptedPayload!);
    expect(decoded).toEqual({ kind: 'predicates', predicates: [worksAt, competesWith] });

    // B was already connected: it gets the live delta, projects it to disk, and
    // hands it to the in-process registry.
    await waitUntil(() => b.applied.length > 0);
    expect(readWorkspacePredicateRegistry(b.workspacePath)).toEqual([worksAt, competesWith]);
    expect(b.applied.at(-1)).toEqual([worksAt, competesWith]);

    // A's own ack settles its outbox: nothing left to push, nothing re-sent.
    await waitUntil(() => a.state.get(a.workspacePath).syncId === row.syncId);
    await a.engine.flushSchemas();
    expect(server.room.receivedSchemaMutations
      .filter(m => m.schemaType === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE)).toHaveLength(1);
  });

  it('publishes labels.yaml under __labels__, and two peers\' concurrent additions both survive', async () => {
    const server = createFakeServer();
    const a = await connectPeer('a', server);
    const b = await connectPeer('b', server);
    unregister.push(registerTrackerSchemaFlushHandler((ws) =>
      peers.find(p => p.workspacePath === ws)?.engine.flushSchemas()));
    const labelsRow = () => server.room.getStoredSchemas().find(s => s.schemaType === TRACKER_LABEL_REGISTRY_SCHEMA_TYPE);

    const base: LabelRegistry = { labels: [{ id: 'capability', label: 'Capability' }], properties: [], claimProperties: {} };
    await writeWorkspaceLabelRegistry(a.workspacePath, base);
    await waitUntil(() => b.appliedLabels.length > 0);
    expect(readWorkspaceLabelRegistry(b.workspacePath)).toEqual(base);

    // Each peer adds a different label before seeing the other's.
    await writeWorkspaceLabelRegistry(a.workspacePath, { ...base, labels: [...base.labels, { id: 'feature', label: 'Feature' }] });
    await writeWorkspaceLabelRegistry(b.workspacePath, { ...base, labels: [...base.labels, { id: 'topic', label: 'Topic' }] });

    const ids = (registry: LabelRegistry | null) => (registry?.labels ?? []).map(l => l.id).sort();
    await waitUntil(() => {
      const row = labelsRow();
      const decoded = row?.encryptedPayload ? decodeTrackerSchemaPayload(row.schemaType, row.encryptedPayload) : null;
      return decoded?.kind === 'labels' && ids(decoded.registry).join() === 'capability,feature,topic';
    }, 4000);
    await waitUntil(() => ids(readWorkspaceLabelRegistry(a.workspacePath)).join() === 'capability,feature,topic'
      && ids(readWorkspaceLabelRegistry(b.workspacePath)).join() === 'capability,feature,topic', 4000);
  });

  it('gives a peer with no predicates.yaml the room\'s registry when it connects', async () => {
    // `.nimbalyst/` is gitignored: a teammate's checkout has no copy at all, so
    // the room is the only way the registry reaches them.
    const server = createFakeServer();
    const a = await connectPeer('a', server);
    unregister.push(registerTrackerSchemaFlushHandler((ws) =>
      peers.find(p => p.workspacePath === ws)?.engine.flushSchemas()));
    await writeWorkspacePredicateRegistry(a.workspacePath, [worksAt, competesWith]);
    await waitUntil(() => predicatesRow(server.room) !== undefined);

    const d = await connectPeer('d', server);
    await waitUntil(() => fs.existsSync(path.join(d.workspacePath, '.nimbalyst', 'predicates.yaml')));
    expect(readWorkspacePredicateRegistry(d.workspacePath)).toEqual([worksAt, competesWith]);
    expect(d.applied.at(-1)).toEqual([worksAt, competesWith]);

    // Receiving is not an edit: D has nothing of its own to publish back.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(server.room.receivedSchemaMutations
      .filter(m => m.schemaType === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE)).toHaveLength(1);
  });

  it.each([
    ['a retracted registry', null],
    ['an empty registry', JSON.stringify({ payloadKind: 'trackerPredicateRegistry', version: 1, predicates: [] })],
  ])('publishes this machine\'s registry over %s instead of being emptied by it', async (_label, seedModel) => {
    const server = createFakeServer();
    // Put the empty state in the room the way a client would.
    let seed = [{ type: TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE, model: seedModel, deleted: seedModel === null }];
    const seeder = new TrackerSyncEngine({
      serverUrl: 'ws://fake',
      orgId: 'test-org',
      teamProjectId: 'tracker-test-project',
      teamMemberId: asTeamMemberId('member-seeder'),
      persistence: new InMemoryTrackerPersistence(),
      schemaSync: { listUnsynced: async () => seed, applyRemote: async () => { seed = []; } },
      getJwt: async () => asTeamJwt('fake-jwt'),
      createWebSocket: () => server.connect(),
    });
    peers.push({ workspacePath: path.join(tmp, 'seeder'), engine: seeder, state: createInMemoryPredicateRegistrySyncStateStore(), applied: [], appliedLabels: [] });
    await seeder.connect();
    await waitUntil(() => predicatesRow(server.room) !== undefined && seed.length === 0);

    // The machine that holds the only copy of the team's verbs connects.
    const mPath = path.join(tmp, 'm');
    fs.mkdirSync(mPath, { recursive: true });
    await writeWorkspacePredicateRegistry(mPath, [worksAt, competesWith]);
    const registryFile = path.join(mPath, '.nimbalyst', 'predicates.yaml');
    const before = fs.readFileSync(registryFile, 'utf-8');
    await connectPeer('m', server);

    await waitUntil(() => {
      const row = predicatesRow(server.room);
      const decoded = row?.encryptedPayload ? decodeTrackerSchemaPayload(row.schemaType, row.encryptedPayload) : null;
      return decoded?.kind === 'predicates' && decoded.predicates.length === 2;
    });
    expect(fs.readFileSync(registryFile, 'utf-8')).toBe(before);
  });

  it('lets a teammate\'s deletion stick instead of re-publishing it from a stale copy', async () => {
    const server = createFakeServer();
    const a = await connectPeer('a', server);
    const b = await connectPeer('b', server);
    unregister.push(registerTrackerSchemaFlushHandler((ws) =>
      peers.find(p => p.workspacePath === ws)?.engine.flushSchemas()));
    await writeWorkspacePredicateRegistry(a.workspacePath, [worksAt, competesWith]);
    await waitUntil(() => readWorkspacePredicateRegistry(b.workspacePath)?.length === 2);

    await writeWorkspacePredicateRegistry(a.workspacePath, [worksAt]);
    await waitUntil(() => readWorkspacePredicateRegistry(b.workspacePath)?.length === 1);
    // Past the flush debounce: B must have nothing of its own to push.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(server.room.receivedSchemaMutations
      .filter(m => m.schemaType === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE)).toHaveLength(2);
  });

  it('never silently drops a predicate a peer holds locally that the room lacks', async () => {
    const server = createFakeServer();
    const a = await connectPeer('a', server);
    unregister.push(registerTrackerSchemaFlushHandler((ws) =>
      peers.find(p => p.workspacePath === ws)?.engine.flushSchemas()));
    await writeWorkspacePredicateRegistry(a.workspacePath, [worksAt]);
    await waitUntil(() => predicatesRow(server.room) !== undefined);

    // C's checkout already carries a predicate the room has never seen. The
    // room's registry lands on top of it and must not erase it: C keeps both
    // and publishes the union.
    const cPath = path.join(tmp, 'c');
    fs.mkdirSync(cPath, { recursive: true });
    await writeWorkspacePredicateRegistry(cPath, [competesWith]);
    await connectPeer('c', server);

    await waitUntil(() => {
      const current = predicatesRow(server.room);
      const decoded = current && decodeTrackerSchemaPayload(current.schemaType, current.encryptedPayload!);
      return decoded?.kind === 'predicates' && decoded.predicates.length === 2;
    });
    expect(readWorkspacePredicateRegistry(cPath)?.map(p => p.id).sort()).toEqual(['competes-with', 'works-at']);
  });
});

describe('vocabulary lanes, one peer at a time', () => {
  let workspacePath: string;
  beforeEach(() => { workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-vocab-lane-')); });
  afterEach(() => { fs.rmSync(workspacePath, { recursive: true, force: true }); });

  const registry = (labels: LabelRegistry['labels']): LabelRegistry => ({ labels, properties: [], claimProperties: {} });
  const labelsDef = (value: LabelRegistry, syncId: number) => ({
    type: TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
    model: encodeTrackerLabelRegistryPayload(value),
    syncId,
  });

  it('never installs an invalid label registry when two valid edits meet; the room wins', async () => {
    const base = registry([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    const state = createInMemoryLabelRegistrySyncStateStore();
    state.set(workspacePath, { syncId: 1, baseline: canonicalLabelRegistryJson(base), pushed: null, rejected: null });
    const local = registry([{ id: 'a', label: 'A', broader: ['b'] }, { id: 'b', label: 'B' }]);
    await writeWorkspaceLabelRegistry(workspacePath, local);
    const remote = registry([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', broader: ['a'] }]);
    const installed: LabelRegistry[] = [];

    const result = await applyRemoteLabelRegistry(workspacePath, labelsDef(remote, 2), {
      state,
      onApplied: (_ws, applied) => { installed.push(applied); },
    });

    expect(result).toEqual({ applied: true, deleted: false });
    // The file still reads, so the next delivery and the next push both work.
    expect(canonicalLabelRegistryJson(readWorkspaceLabelRegistry(workspacePath)!)).toBe(canonicalLabelRegistryJson(remote));
    expect(installed.map(canonicalLabelRegistryJson)).toEqual([canonicalLabelRegistryJson(remote)]);
    expect(listUnsyncedLabelRegistry(workspacePath, { state })).toEqual([]);
  });

  it('keeps a push offered mid-apply, so its own ack is not read as a deletion', async () => {
    const base = registry([{ id: 'capability', label: 'Capability' }]);
    const withTopic = registry([...base.labels, { id: 'topic', label: 'Topic' }]);
    const state = createInMemoryLabelRegistrySyncStateStore();
    state.set(workspacePath, { syncId: 1, baseline: canonicalLabelRegistryJson(base), pushed: null, rejected: null });
    await writeWorkspaceLabelRegistry(workspacePath, withTopic);

    // The flush reads the file while the teammate's registry is being written.
    const applying = applyRemoteLabelRegistry(workspacePath,
      labelsDef(registry([...base.labels, { id: 'feature', label: 'Feature' }]), 2), { state });
    expect(listUnsyncedLabelRegistry(workspacePath, { state })).toHaveLength(1);
    await applying;

    await applyRemoteLabelRegistry(workspacePath, labelsDef(withTopic, 3), { state });
    expect(readWorkspaceLabelRegistry(workspacePath)!.labels.map(l => l.id).sort()).toEqual(['capability', 'feature', 'topic']);
  });

  it('publishes a registry emptied on purpose, but never a missing file', async () => {
    const base = registry([{ id: 'feature', label: 'Feature' }]);
    const state = createInMemoryLabelRegistrySyncStateStore();
    state.set(workspacePath, { syncId: 1, baseline: canonicalLabelRegistryJson(base), pushed: null, rejected: null });
    expect(listUnsyncedLabelRegistry(workspacePath, { state })).toEqual([]);

    await writeWorkspaceLabelRegistry(workspacePath, registry([]));
    const [change] = listUnsyncedLabelRegistry(workspacePath, { state });
    expect(change && decodeTrackerSchemaPayload(change.type, change.model!)).toEqual({ kind: 'labels', registry: registry([]) });

    // A peer that never held a non-empty room registry has nothing to clear.
    const fresh = createInMemoryLabelRegistrySyncStateStore();
    expect(listUnsyncedLabelRegistry(workspacePath, { state: fresh })).toEqual([]);
  });

  it('publishes a predicate registry emptied on purpose, but never a missing file', async () => {
    const state = createInMemoryPredicateRegistrySyncStateStore();
    state.set(workspacePath, { syncId: 1, baseline: canonicalPredicateRegistryJson([worksAt]), pushed: null, rejected: null });
    expect(listUnsyncedPredicateRegistry(workspacePath, { state })).toEqual([]);

    await writeWorkspacePredicateRegistry(workspacePath, []);
    const [change] = listUnsyncedPredicateRegistry(workspacePath, { state });
    expect(change && decodeTrackerSchemaPayload(change.type, change.model!)).toEqual({ kind: 'predicates', predicates: [] });
  });

  it('lets the room delete a predicate this peer edited instead of republishing the edit', () => {
    const edited = { ...worksAt, label: 'is employed at' };
    const result = mergePredicateRegistries({ baseline: [worksAt, competesWith], local: [edited, competesWith], remote: [competesWith] });
    expect(result.merged).toEqual([competesWith]);
    expect(result.keptLocal).toEqual([]);
    expect(result.overriddenLocal).toEqual(['works-at']);
  });
});
