// @vitest-environment node

/**
 * The schema lane is where a browser tab can quietly render a tracker that is
 * not the tracker the team is using.
 *
 * An override of a builtin travels as a DELTA against the sender's builtin seed
 * (#1178), never as a full model. A host that treats the payload as a model
 * registers a type with no fields; a host that resolves it against the wrong
 * seed registers the wrong fields. Neither prints anything -- the grid simply
 * draws the wrong columns.
 */

import { describe, expect, it } from 'vitest';
import {
  encodeTrackerLabelRegistryPayload,
  encodeTrackerPredicateRegistryPayload,
  encodeTrackerSchemaPatchPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import { BrowserTrackerSchemaStore, resolveBrowserTrackerSchema } from '../browser/BrowserTrackerSchemaStore';

const seed = {
  type: 'bug',
  displayName: 'Bug',
  displayNamePlural: 'Bugs',
  icon: 'bug_report',
  color: '#f00',
  idPrefix: 'BUG',
  idFormat: 'uuid',
  modes: { inline: true, fullDocument: false },
  // A field the sender's build never mentioned: it must survive the delta.
  fields: [
    { name: 'title', type: 'text' },
    { name: 'severity', type: 'text' },
  ],
} as unknown as TrackerDataModel;

describe('resolving one inbound schema payload', () => {
  it('applies a delta on top of THIS build\'s builtin, keeping fields the sender never had', () => {
    const payload = encodeTrackerSchemaPatchPayload({
      type: 'bug',
      displayNamePlural: 'Defects',
    });
    const resolved = resolveBrowserTrackerSchema('bug', payload, () => seed);
    expect(resolved?.displayNamePlural).toBe('Defects');
    expect(resolved?.fields.map((field) => field.name)).toEqual(['title', 'severity']);
  });

  it('drops a delta whose builtin this build does not ship, rather than half-registering it', () => {
    const payload = encodeTrackerSchemaPatchPayload({ type: 'unknown-type', displayName: 'X' });
    expect(resolveBrowserTrackerSchema('unknown-type', payload, () => undefined)).toBeNull();
    expect(resolveBrowserTrackerSchema('bug', 'not json', () => seed)).toBeNull();
  });
});

describe('a personal tracker type, in a host with no personal lane', () => {
  const personalSeed = { ...seed, type: 'idea', sharing: 'personal' } as unknown as TrackerDataModel;

  it('is neither seeded from the builtins nor accepted from the room', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed, personalSeed] });
    try {
      expect(store.getState().trackerTypes.map((model) => model.type)).toEqual(['bug']);

      // Arriving as a full model changes nothing: the type stays absent rather
      // than becoming a selectable tracker no room carries items for.
      await store.schemaSync.applyRemote({
        type: 'idea',
        model: JSON.stringify(personalSeed),
        syncId: 1 as never,
      });
      expect(store.getState().trackerTypes.map((model) => model.type)).toEqual(['bug']);

      // And a team type the room later makes personal is withdrawn, not left
      // behind as a stale team surface.
      await store.schemaSync.applyRemote({
        type: 'bug',
        model: JSON.stringify({ ...seed, sharing: 'personal' }),
        syncId: 2 as never,
      });
      expect(store.getState().trackerTypes).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  it('is projected once the room shares it as the team\'s', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [personalSeed] });
    try {
      await store.schemaSync.applyRemote({
        type: 'idea',
        model: encodeTrackerSchemaPatchPayload({ type: 'idea', sharing: 'team' }),
        syncId: 1 as never,
      });
      expect(store.getState().trackerTypes.map((model) => model.type)).toEqual(['idea']);
    } finally {
      store.dispose();
    }
  });
});

describe('the predicate registry (NIM-6653)', () => {
  it('is readable from the store state, and an unreadable push leaves the last one in force', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    const seen: string[][] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state.predicates.map((p) => p.id)));
    try {
      expect(store.getState().predicates).toEqual([]);
      const worksAt = {
        id: 'works-at',
        label: 'works at',
        inverseLabel: 'employs',
        subjectKinds: ['*'],
        valueShape: 'entity' as const,
        direction: 'directed' as const,
      };
      await store.schemaSync.applyRemote({
        type: TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
        model: encodeTrackerPredicateRegistryPayload([worksAt]),
        syncId: 1 as never,
      });
      expect(store.getState().predicates).toEqual([worksAt]);
      expect(seen.at(-1)).toEqual(['works-at']);

      await store.schemaSync.applyRemote({
        type: TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
        model: JSON.stringify({ payloadKind: 'trackerPredicateRegistry', version: 1, predicates: [{ id: 'x' }] }),
        syncId: 2 as never,
      });
      expect(store.getState().predicates).toEqual([worksAt]);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });
});

describe('the label registry', () => {
  it('installs a published registry and keeps it when a later push is unreadable', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    try {
      const registry = {
        labels: [{ id: 'capability', label: 'Capability' }, { id: 'feature', label: 'Feature', broader: ['capability'] }],
        properties: [],
        claimProperties: {},
      };
      await store.schemaSync.applyRemote({
        type: TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
        model: encodeTrackerLabelRegistryPayload(registry),
        syncId: 1 as never,
      });
      expect(store.getState().labels).toEqual(registry);
      expect(globalRegistry.resolveLabels({ labels: ['feature'] })).toEqual(['feature', 'capability']);

      await store.schemaSync.applyRemote({
        type: TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
        model: JSON.stringify({ payloadKind: 'trackerLabelRegistry', version: 1, registry: { labels: [{ id: 'x' }] } }),
        syncId: 2 as never,
      });
      expect(store.getState().labels).toEqual(registry);
    } finally {
      store.dispose();
    }
  });
});

describe('defining a new team type from the browser', () => {
  const customer = { ...seed, type: 'customer', displayName: 'Customer', sharing: 'team' } as unknown as TrackerDataModel;

  it('queues a create-only definition and settles on its own ack, not on a broadcast of the same type', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    try {
      let settled = false;
      const defined = store.defineTeamType(customer).then(() => { settled = true; });
      const queued = await store.schemaSync.listUnsynced();
      expect(queued.map(({ type, deleted, createOnly }) => ({ type, deleted, createOnly })))
        .toEqual([{ type: 'customer', deleted: false, createOnly: 'required' }]);
      expect(JSON.parse(queued[0].model!)).toMatchObject({ type: 'customer', sharing: 'team', fields: customer.fields });

      // Another client's definition of the same id is not this creation's answer.
      await store.schemaSync.applyRemote({ type: 'customer', model: JSON.stringify({ ...customer, displayName: 'Client' }), syncId: 3 as never });
      await Promise.resolve();
      expect(settled).toBe(false);

      store.schemaSync.onSettled?.({ type: 'customer', model: queued[0].model, accepted: true });
      await defined;
      expect(await store.schemaSync.listUnsynced()).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  it('rejects when the room refuses it or cannot refuse an existing type, and stops offering it', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    try {
      const raced = store.defineTeamType(customer);
      const [queued] = await store.schemaSync.listUnsynced();
      store.schemaSync.onSettled?.({ type: 'customer', model: queued.model, accepted: false, error: { code: 'schemaExists', message: 'exists' } });
      await expect(raced).rejects.toThrow('Someone else just created a type named "customer"');
      expect(await store.schemaSync.listUnsynced()).toEqual([]);

      const oldServer = store.defineTeamType({ ...customer, type: 'vendor' });
      const [vendor] = await store.schemaSync.listUnsynced();
      store.schemaSync.onSettled?.({ type: 'vendor', model: vendor.model, accepted: false, error: { code: 'createOnlyUnsupported', message: 'This team\'s server must be updated before new types can be created here.' } });
      await expect(oldServer).rejects.toThrow('server must be updated');
    } finally {
      store.dispose();
    }
  });

  it('refuses an existing id or a personal definition without queueing anything', async () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    try {
      await expect(store.defineTeamType({ ...customer, type: 'bug' })).rejects.toThrow('A type named "bug" already exists.');
      await expect(store.defineTeamType({ ...customer, sharing: 'personal' })).rejects.toThrow('only team types');
      expect(await store.schemaSync.listUnsynced()).toEqual([]);
    } finally {
      store.dispose();
    }
  });
});

describe('the navigation lane', () => {
  it('keeps a malformed entry out of the tree instead of rendering a folder with no name', () => {
    const store = new BrowserTrackerSchemaStore({ builtins: [seed] });
    try {
      void store.navigationSync.applyRemote({
        entryId: 'folder:d',
        payload: JSON.stringify({ entryId: 'folder:d', kind: 'folder', folderId: 'd', name: 'Delivery', sortKey: 'a0', ownership: 'team' }),
        syncId: 1 as never,
      });
      void store.navigationSync.applyRemote({
        entryId: 'folder:bad',
        payload: JSON.stringify({ entryId: 'folder:bad', kind: 'folder' }),
        syncId: 2 as never,
      });
      expect(store.getState().navigationEntries.map((entry) => entry.entryId)).toEqual(['folder:d']);
    } finally {
      store.dispose();
    }
  });
});
