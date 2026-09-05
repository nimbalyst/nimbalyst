// @vitest-environment node

/**
 * Recorded tracker-to-tracker relationships.
 *
 * Every case here is taken from real rows in this workspace's database, because
 * the shapes are the whole difficulty:
 *
 *  - Values live nested under `data.customFields.<field>`, which is the durable
 *    synced form. Reading `data.<field>` finds nothing for any item that has
 *    ever synced.
 *  - The same field NAME is a relationship on one tracker type and a plain
 *    string on another (`bug.area` is a relationship; `github-issue.area` is
 *    `"performance"`). Only the type's field definitions can tell them apart.
 *  - A value may omit `relationshipTypeKey`; the field definition carries it.
 *  - Single-value fields store a bare object, not an array.
 */
import { describe, expect, it } from 'vitest';
import {
  isRelationshipField,
  readStoredFieldValue,
  relationshipFieldsOf,
  trackerRelationshipEdges,
  type TrackerFieldDefinition,
} from '../trackerRelationships';

const BUG_FIELDS: TrackerFieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'area', type: 'relationship', relationshipTypeKey: 'child-of', targetTrackerTypes: ['feature-module', 'product-feature'] },
  { name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on' },
  { name: 'blocks', type: 'relationship', relationshipTypeKey: 'blocks' },
];
const ISSUE_FIELDS: TrackerFieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'area', type: 'select' },
];

function row(id: string, type: string, data: Record<string, unknown>) {
  return {
    id, issue_number: null, issue_key: null, type, data,
    document_path: null, title: 't', status: 'open', created: null, updated: null,
  };
}

describe('reading relationship values', () => {
  it('prefers the nested customFields value over a stale top-level shadow', () => {
    const data = { modules: [{ itemId: 'stale' }], customFields: { modules: [{ itemId: 'mod_1' }] } };

    // The nested bag is the durable synced location; a top-level copy is a
    // legacy shadow that the sync round-trip no longer maintains.
    expect(readStoredFieldValue(data, 'modules')).toEqual([{ itemId: 'mod_1' }]);
    expect(readStoredFieldValue({ modules: [{ itemId: 'legacy' }] }, 'modules')).toEqual([
      { itemId: 'legacy' },
    ]);
  });

  it('recognizes relationship fields including the legacy reference alias', () => {
    expect(isRelationshipField({ name: 'a', type: 'relationship' })).toBe(true);
    expect(isRelationshipField({ name: 'a', type: 'reference' })).toBe(true);
    expect(isRelationshipField({ name: 'a', type: 'select' })).toBe(false);
    expect(relationshipFieldsOf(BUG_FIELDS).map(f => f.name)).toEqual(['area', 'dependsOn', 'blocks']);
  });
});

describe('emitting recorded relationships', () => {
  it('emits an edge per recorded target with the exact field and relation key as its basis', () => {
    const edges = trackerRelationshipEdges(
      row('feat_1', 'product-feature', {
        customFields: {
          modules: [
            { itemId: 'mod_inv_bd42e64b68eb', trackerType: 'feature-module', title: 'Editors', relationshipTypeKey: 'child-of' },
          ],
        },
      }),
      [{ name: 'modules', type: 'relationship', relationshipTypeKey: 'child-of' }],
    );

    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge!.sourceId).toBe('tracker:feat_1');
    expect(edge!.targetId).toBe('tracker:mod_inv_bd42e64b68eb');
    expect(edge!.type).toBe('part_of');
    expect(edge!.provenance?.kind).toBe('recorded');
    // The basis has to name the field and the relation key exactly. A generic
    // "related" label would lose which recorded fact produced the edge.
    expect(edge!.provenance?.basis).toContain('modules');
    expect(edge!.provenance?.basis).toContain('child-of');
    expect(edge!.label).toBe('child-of');
  });

  it('falls back to the field definition when a value omits its relation key', () => {
    // Real `epic.children` entries carry only itemId/issueKey/title/trackerType.
    const edges = trackerRelationshipEdges(
      row('epic_1', 'epic', {
        customFields: {
          children: [{ itemId: 'epic_2', issueKey: 'NIM-933', title: 'Shared Trackers', trackerType: 'epic' }],
        },
      }),
      [{ name: 'children', type: 'relationship', relationshipTypeKey: 'parent-of' }],
    );

    expect(edges[0]!.type).toBe('contains');
    expect(edges[0]!.label).toBe('parent-of');
    expect(edges[0]!.provenance?.basis).toContain('children');
  });

  it('reads a single-value relationship stored as a bare object', () => {
    const edges = trackerRelationshipEdges(
      row('cust_1', 'customer', {
        customFields: { parentBusiness: { itemId: 'cust_parent', direction: 'out' } },
      }),
      [{ name: 'parentBusiness', type: 'relationship', relationshipTypeKey: 'child-of', multiValue: false }],
    );

    expect(edges.map(e => e.targetId)).toEqual(['tracker:cust_parent']);
  });

  it('records "blocks" in the direction the relation actually runs', () => {
    const edges = trackerRelationshipEdges(
      row('bug_1', 'bug', { customFields: { blocks: [{ itemId: 'bug_2' }] } }),
      BUG_FIELDS,
    );

    // "bug_1 blocks bug_2" means bug_2 is the one that is blocked. Emitting
    // `bug_1 blocked_by bug_2` would invert the dependency.
    expect(edges[0]).toMatchObject({
      sourceId: 'tracker:bug_2',
      targetId: 'tracker:bug_1',
      type: 'blocked_by',
    });
    expect(edges[0]!.provenance?.basis).toContain('bug_1');
  });

  it('does not read a same-named scalar field on a different tracker type as a relationship', () => {
    // `github-issue.area` is the string "performance"; `bug.area` is a
    // relationship. A name-based rule turns a label into a phantom edge.
    const asRelationship = trackerRelationshipEdges(
      row('bug_1', 'bug', { customFields: { area: [{ itemId: 'mod_1' }] } }),
      BUG_FIELDS,
    );
    const asScalar = trackerRelationshipEdges(
      row('gh_1', 'github-issue', { customFields: { area: 'performance' } }),
      ISSUE_FIELDS,
    );

    expect(asRelationship.map(e => e.targetId)).toEqual(['tracker:mod_1']);
    expect(asScalar).toEqual([]);
  });

  it('keeps an unrecognized relation key rather than relabelling it', () => {
    const edges = trackerRelationshipEdges(
      row('x_1', 'custom', { customFields: { rel: [{ itemId: 'x_2', relationshipTypeKey: 'invented-by' }] } }),
      [{ name: 'rel', type: 'relationship' }],
    );

    expect(edges[0]!.label).toBe('invented-by');
    // The link itself is recorded even though this layer has no structural
    // meaning for the key; the basis says exactly what was read.
    expect(edges[0]!.provenance?.kind).toBe('recorded');
    expect(edges[0]!.provenance?.basis).toContain('invented-by');
  });

  it('drops self-links and entries with no target, and dedupes repeats', () => {
    const edges = trackerRelationshipEdges(
      row('a', 'bug', {
        customFields: {
          dependsOn: [{ itemId: 'b' }, { itemId: 'b' }, { itemId: 'a' }, { title: 'no id' }, null],
        },
      }),
      BUG_FIELDS,
    );

    expect(edges.map(e => e.targetId)).toEqual(['tracker:b']);
  });

  it('emits nothing when the type has no relationship fields', () => {
    expect(trackerRelationshipEdges(row('a', 'note', { customFields: { x: 1 } }), ISSUE_FIELDS)).toEqual([]);
  });
});
