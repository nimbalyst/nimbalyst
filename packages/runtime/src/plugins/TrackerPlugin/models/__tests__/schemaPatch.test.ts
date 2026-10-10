// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  resolveTrackerSchemaPatch,
  diffTrackerSchema,
  parseTrackerSchemaPatchYAML,
  serializeTrackerSchemaPatchYAML,
  resolveTrackerTypeInheritance,
  type TrackerSchemaPatch,
} from '@nimbalyst/tracker-schema';
import {
  decodeTrackerSchemaPayload,
  encodeTrackerSchemaPatchPayload,
  encodeTrackerSchemaModelPayload,
  encodeTrackerPredicateRegistryPayload,
  encodeTrackerLabelRegistryPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '../schemaSyncPayload';
import type { LabelRegistry, PredicateDefinition } from '@nimbalyst/tracker-schema';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';

function featureSeed(): TrackerDataModel {
  return {
    type: 'feature',
    displayName: 'Feature',
    displayNamePlural: 'Features',
    icon: 'rocket_launch',
    color: '#10b981',
    modes: { inline: true, fullDocument: false },
    sharing: 'team',
    draftByDefault: false,
    idPrefix: 'feat',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      {
        name: 'status',
        type: 'select',
        default: 'to-do',
        options: [
          { value: 'to-do', label: 'To Do', icon: 'circle' },
          { value: 'in-progress', label: 'In Progress', icon: 'motion_photos_on' },
          { value: 'done', label: 'Done', icon: 'check_circle' },
        ],
      },
    ],
    inlineTemplate: '{icon} {title} {status}',
    roles: { title: 'title', workflowStatus: 'status' },
  };
}

describe('resolveTrackerSchemaPatch', () => {
  it('adds a select option by value without redeclaring the schema', () => {
    const patch: TrackerSchemaPatch = {
      type: 'feature',
      fields: [
        {
          name: 'status',
          options: {
            set: [{ value: 'wont-do', label: "Won't Do", icon: 'do_not_disturb_on', color: '#64748b' }],
          },
        },
      ],
    };
    const resolved = resolveTrackerSchemaPatch(featureSeed(), patch);
    const status = resolved.fields.find((f) => f.name === 'status')!;
    expect(status.options!.map((o) => o.value)).toEqual(['to-do', 'in-progress', 'done', 'wont-do']);
    expect(status.options!.find((o) => o.value === 'wont-do')!.label).toBe("Won't Do");
    // Seed untouched.
    expect(featureSeed().fields.find((f) => f.name === 'status')!.options).toHaveLength(3);
  });

  it('updates an existing option by value (shallow merge keeps other props)', () => {
    const patch: TrackerSchemaPatch = {
      type: 'feature',
      fields: [{ name: 'status', options: { set: [{ value: 'done', label: 'Shipped' }] } }],
    };
    const resolved = resolveTrackerSchemaPatch(featureSeed(), patch);
    const done = resolved.fields.find((f) => f.name === 'status')!.options!.find((o) => o.value === 'done')!;
    expect(done.label).toBe('Shipped');
    expect(done.icon).toBe('check_circle'); // preserved
  });

  it('removes and reorders options', () => {
    const patch: TrackerSchemaPatch = {
      type: 'feature',
      fields: [{ name: 'status', options: { remove: ['in-progress'], order: ['done', 'to-do'] } }],
    };
    const resolved = resolveTrackerSchemaPatch(featureSeed(), patch);
    expect(resolved.fields.find((f) => f.name === 'status')!.options!.map((o) => o.value)).toEqual([
      'done',
      'to-do',
    ]);
  });

  it('shallow-merges scalars, sync, and roles; last-writer wins', () => {
    const patch: TrackerSchemaPatch = {
      type: 'feature',
      displayName: 'Capability',
      color: '#123456',
      draftByDefault: true,
      roles: { priority: 'priority' },
    };
    const resolved = resolveTrackerSchemaPatch(featureSeed(), patch);
    expect(resolved.displayName).toBe('Capability');
    expect(resolved.color).toBe('#123456');
    expect(resolved.sharing).toBe('team');
    expect(resolved.draftByDefault).toBe(true);
    expect(resolved.roles).toEqual({ title: 'title', workflowStatus: 'status', priority: 'priority' });
  });

  // Builtin projection and team transport both run through this exact chain:
  // model diff -> wire envelope -> peer decode -> patch resolution. A test that
  // starts with a hand-written patch misses scalar omissions in the diff.
  it('carries sharing and lifecycle scalars through the builtin wire payload both ways', () => {
    const roundTrip = (seed: TrackerDataModel, target: TrackerDataModel) => {
      const patch = diffTrackerSchema(seed, target);
      const projected = resolveTrackerSchemaPatch(
        seed,
        parseTrackerSchemaPatchYAML(serializeTrackerSchemaPatchYAML(patch)),
      );
      const payload = encodeTrackerSchemaPatchPayload(patch);
      const decoded = decodeTrackerSchemaPayload(target.type, payload);
      expect(decoded?.kind).toBe('patch');
      return {
        payload: JSON.parse(payload),
        projected,
        resolved: resolveTrackerSchemaPatch(
          seed,
          (decoded as { kind: 'patch'; patch: TrackerSchemaPatch }).patch,
        ),
      };
    };

    const personal = {
      ...featureSeed(),
      sharing: 'personal' as const,
      draftByDefault: false,
      archived: false,
    };
    const archivedTeam = {
      ...featureSeed(),
      sharing: 'team' as const,
      draftByDefault: true,
      archived: true,
    };

    const promoted = roundTrip(personal, archivedTeam);
    expect(promoted.payload.patch).toMatchObject({
      sharing: 'team',
      draftByDefault: true,
      archived: true,
    });
    expect(promoted.resolved).toMatchObject({
      sharing: 'team',
      draftByDefault: true,
      archived: true,
    });
    expect(promoted.projected).toMatchObject({
      sharing: 'team',
      draftByDefault: true,
      archived: true,
    });

    const restored = roundTrip(archivedTeam, personal);
    expect(restored.payload.patch).toMatchObject({
      sharing: 'personal',
      draftByDefault: false,
      archived: false,
    });
    expect(restored.resolved).toMatchObject({
      sharing: 'personal',
      draftByDefault: false,
      archived: false,
    });
    expect(restored.projected).toMatchObject({
      sharing: 'personal',
      draftByDefault: false,
      archived: false,
    });
  });

  it('adds and removes fields by name, preserving order', () => {
    const patch: TrackerSchemaPatch = {
      type: 'feature',
      fields: [
        { name: 'severity', set: { type: 'select' }, options: { set: [{ value: 'sev1', label: 'Sev 1' }] } },
        { name: 'title', remove: true },
      ],
    };
    const resolved = resolveTrackerSchemaPatch(featureSeed(), patch);
    expect(resolved.fields.map((f) => f.name)).toEqual(['status', 'severity']);
    expect(resolved.fields.find((f) => f.name === 'severity')!.options![0].value).toBe('sev1');
  });

  it('throws when adding a field without a type', () => {
    const patch: TrackerSchemaPatch = { type: 'feature', fields: [{ name: 'x', set: { required: true } }] };
    expect(() => resolveTrackerSchemaPatch(featureSeed(), patch)).toThrow(/without a 'type'/);
  });

  it('throws on a type mismatch', () => {
    const patch: TrackerSchemaPatch = { type: 'bug' };
    expect(() => resolveTrackerSchemaPatch(featureSeed(), patch)).toThrow(/does not match seed type/);
  });

  it('upstream flow-through: the same patch resolves against a CHANGED seed', () => {
    // Simulate an upstream builtin improvement: a new field + a new status option
    // land in the seed after the patch was authored.
    const upgradedSeed = featureSeed();
    upgradedSeed.fields.push({ name: 'owner', type: 'user' });
    upgradedSeed.fields.find((f) => f.name === 'status')!.options!.push({
      value: 'blocked',
      label: 'Blocked',
      icon: 'block',
    });

    const patch: TrackerSchemaPatch = {
      type: 'feature',
      fields: [
        { name: 'status', options: { set: [{ value: 'wont-do', label: "Won't Do" }] } },
      ],
    };
    const resolved = resolveTrackerSchemaPatch(upgradedSeed, patch);
    // The patch's option AND the upstream additions are both present.
    expect(resolved.fields.some((f) => f.name === 'owner')).toBe(true);
    const values = resolved.fields.find((f) => f.name === 'status')!.options!.map((o) => o.value);
    expect(values).toEqual(['to-do', 'in-progress', 'done', 'blocked', 'wont-do']);
  });
});

describe('diffTrackerSchema round-trips through resolve', () => {
  it('produces a patch that reconstructs the target from the seed', () => {
    const seed = featureSeed();
    const target = featureSeed();
    target.displayName = 'Capability';
    target.fields.find((f) => f.name === 'status')!.options!.push({
      value: 'wont-do',
      label: "Won't Do",
      icon: 'do_not_disturb_on',
    });
    target.fields.push({ name: 'owner', type: 'user' });

    const patch = diffTrackerSchema(seed, target);
    const resolved = resolveTrackerSchemaPatch(seed, patch);
    expect(resolved.displayName).toBe('Capability');
    expect(resolved.fields.find((f) => f.name === 'status')!.options!.map((o) => o.value)).toEqual([
      'to-do',
      'in-progress',
      'done',
      'wont-do',
    ]);
    expect(resolved.fields.some((f) => f.name === 'owner')).toBe(true);
  });

  it('an empty diff (seed === target) resolves back to the seed', () => {
    const seed = featureSeed();
    const patch = diffTrackerSchema(seed, featureSeed());
    const resolved = resolveTrackerSchemaPatch(seed, patch);
    expect(resolved).toEqual(seed);
  });
});

// A derived type must not freeze at the sender's app version either: the
// payload carries the declaration so the receiver resolves against its own
// base. This is the model-payload counterpart of the builtin delta above.
describe('derived type wire payload', () => {
  const declared = {
    type: 'product',
    extends: 'feature',
    fields: [{ name: 'license', type: 'string' as const }],
  };

  it('stays a readable full model for a client that knows nothing about extends', () => {
    const sender = featureSeed();
    const resolvedBySender = resolveTrackerTypeInheritance(declared, () => sender).model!;
    const payload = encodeTrackerSchemaModelPayload(resolvedBySender, declared);

    const asPlainModel = JSON.parse(payload) as TrackerDataModel;
    expect(asPlainModel.type).toBe('product');
    expect(asPlainModel.fields.map(f => f.name)).toContain('title');
    expect(asPlainModel.fields.map(f => f.name)).toContain('license');
  });

  it('lets the receiver re-resolve against its own base, picking up a field the sender never had', () => {
    const senderBase = featureSeed();
    const payload = encodeTrackerSchemaModelPayload(
      resolveTrackerTypeInheritance(declared, () => senderBase).model!,
      declared,
    );

    const decoded = decodeTrackerSchemaPayload('product', payload);
    expect(decoded?.kind).toBe('model');
    expect((decoded as { declared?: unknown }).declared).toEqual(declared);
    // The sidecar never leaks into the resolved model the mirror stores.
    expect(decoded && 'declaredForm' in (decoded as { model: object }).model).toBe(false);

    const receiverBase: TrackerDataModel = {
      ...featureSeed(),
      fields: [...featureSeed().fields, { name: 'reviewState', type: 'select' }],
    };
    const reResolved = resolveTrackerTypeInheritance(
      (decoded as { declared: Parameters<typeof resolveTrackerTypeInheritance>[0] }).declared,
      () => receiverBase,
    ).model;

    expect(reResolved?.fields.map(f => f.name)).toContain('reviewState');
  });

  it('emits byte-identical JSON for a plain model with no declaration', () => {
    const model = featureSeed();
    expect(encodeTrackerSchemaModelPayload(model)).toBe(JSON.stringify(model));
  });
});

describe('predicate registry payload (knowledge-scopes 4.1)', () => {
  const predicates: PredicateDefinition[] = [{
    id: 'integrates-with',
    label: 'integrates with',
    subjectKinds: ['product'],
    valueShape: 'entity',
    direction: 'directed',
  }];

  it('round-trips under the reserved schema type', () => {
    const decoded = decodeTrackerSchemaPayload(
      TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
      encodeTrackerPredicateRegistryPayload(predicates),
    );
    expect(decoded).toEqual({ kind: 'predicates', predicates });
  });

  it('refuses a registry arriving as some tracker type, which would lose that type', () => {
    expect(decodeTrackerSchemaPayload('product', encodeTrackerPredicateRegistryPayload(predicates)))
      .toBeNull();
  });

  it('drops an invalid registry rather than handing out a partial one', () => {
    const malformed = JSON.stringify({
      payloadKind: 'trackerPredicateRegistry',
      version: 1,
      predicates: [{ ...predicates[0], valueShape: 'nonsense' }],
    });
    expect(decodeTrackerSchemaPayload(TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE, malformed)).toBeNull();
  });

  it('is dropped by the model/patch rules a client predating it applies', () => {
    const parsed = JSON.parse(encodeTrackerPredicateRegistryPayload(predicates));
    // The two shapes an older client recognizes: a patch discriminator, or a
    // top-level `type` plus `fields[]`. This payload is neither, so that client
    // never acquires a broken tracker type named after the reserved key.
    expect(parsed.payloadKind).not.toBe('trackerSchemaPatch');
    expect(parsed.type).toBeUndefined();
    expect(parsed.fields).toBeUndefined();
  });
});

describe('label registry payload', () => {
  const registry: LabelRegistry = {
    labels: [
      { id: 'capability', label: 'Capability', properties: ['owner'] },
      { id: 'feature', label: 'Feature', broader: ['capability'], properties: ['surface', 'implemented-in'] },
    ],
    properties: [
      { id: 'owner', label: 'Owner', type: 'string' },
      { id: 'surface', label: 'Surface', type: 'select', options: ['desktop', 'web'] },
    ],
    // A predicate that has not arrived on its own row yet must not drop this one.
    claimProperties: { 'implemented-in': { range: ['feature'] } },
  };

  it('round-trips under the reserved schema type and nowhere else', () => {
    const json = encodeTrackerLabelRegistryPayload(registry);
    expect(decodeTrackerSchemaPayload(TRACKER_LABEL_REGISTRY_SCHEMA_TYPE, json)).toEqual({ kind: 'labels', registry });
    expect(decodeTrackerSchemaPayload('entity', json)).toBeNull();
    expect(decodeTrackerSchemaPayload(TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE, json)).toBeNull();
  });

  it('keeps a registry with a newer key and drops one with a broader cycle', () => {
    const newer = { ...registry, labels: [{ ...registry.labels[0], futureKey: 1 }, registry.labels[1]] };
    expect(decodeTrackerSchemaPayload(TRACKER_LABEL_REGISTRY_SCHEMA_TYPE, encodeTrackerLabelRegistryPayload(newer as LabelRegistry)))
      .not.toBeNull();
    const cyclic = { ...registry, labels: [{ ...registry.labels[0], broader: ['feature'] }, registry.labels[1]] };
    expect(decodeTrackerSchemaPayload(TRACKER_LABEL_REGISTRY_SCHEMA_TYPE, encodeTrackerLabelRegistryPayload(cyclic))).toBeNull();
  });

  it('is dropped by the model/patch rules a client predating it applies', () => {
    const parsed = JSON.parse(encodeTrackerLabelRegistryPayload(registry));
    expect(parsed.payloadKind).not.toBe('trackerSchemaPatch');
    expect(parsed.payloadKind).not.toBe('trackerPredicateRegistry');
    expect(parsed.type).toBeUndefined();
    expect(parsed.fields).toBeUndefined();
  });
});
