/**
 * The Collection chip end to end through the shared pill row: a synced member
 * item (relationship value nested under `data.customFields`) must show its
 * membership, open the collection picker rather than the generic relationship
 * editor, and save a value the write path can round-trip.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackerFieldPills } from '../TrackerFieldPills';
import { dbRowToRecord, trackerItemToRecord } from '../../../../core/TrackerRecord';
import type { FieldDefinition } from '../../models/TrackerDataModel';
import type { RelationshipCandidate } from '../RelationshipFieldEditor';

const collectionField: FieldDefinition = {
  name: 'collection',
  type: 'relationship',
  relationshipTypeKey: 'in-collection',
  inverseRelationshipTypeKey: 'has-item',
  inverseFieldId: 'items',
  targetTrackerTypes: ['milestone', 'release'],
  multiValue: true,
};

/** A plain relationship field, to prove non-collection fields are untouched. */
const blockedByField: FieldDefinition = {
  name: 'blockedBy',
  type: 'relationship',
  relationshipTypeKey: 'depends-on',
  targetTrackerTypes: ['bug'],
  multiValue: true,
};

const candidates: RelationshipCandidate[] = [
  { itemId: 'mst_1', title: 'Alpha Launch', issueKey: 'NIM-10', trackerType: 'milestone' },
  { itemId: 'rel_1', title: 'v2.0', issueKey: 'NIM-12', trackerType: 'release' },
];

function renderPills(
  values: Record<string, unknown>,
  overrides: Partial<React.ComponentProps<typeof TrackerFieldPills>> = {},
) {
  const onSave = vi.fn();
  render(
    <TrackerFieldPills
      fields={[collectionField]}
      values={values}
      onSave={onSave}
      relationshipCandidates={new Map([['collection', candidates]])}
      {...overrides}
    />,
  );
  return { onSave };
}

describe('Collection chip', () => {
  it('reads a membership stored nested under customFields', () => {
    // The durable synced shape: relationship values live in data.customFields,
    // never at the top level of `data` (NIM-1305).
    const record = trackerItemToRecord({
      id: 'pln_1',
      type: 'plan',
      title: 'Tracker chips',
      customFields: {
        collection: [{ itemId: 'mst_1', title: 'Alpha Launch', relationshipTypeKey: 'in-collection' }],
      },
    } as any);

    expect(record.fields.collection).toEqual([
      { itemId: 'mst_1', title: 'Alpha Launch', relationshipTypeKey: 'in-collection' },
    ]);

    renderPills(record.fields);
    expect(screen.getByTestId('tracker-field-pill-collection').textContent).toContain('Alpha Launch');
  });

  it('reads a membership nested under customFields straight off a DB row', () => {
    const record = dbRowToRecord({
      id: 'pln_1',
      type: 'plan',
      data: {
        title: 'Tracker chips',
        customFields: { collection: [{ itemId: 'rel_1', title: 'v2.0' }] },
      },
    });

    renderPills(record.fields);
    expect(screen.getByTestId('tracker-field-pill-collection').textContent).toContain('v2.0');
  });

  it('labels a bare itemId link from the live candidate list', () => {
    // Links written without denormalized display data must not surface a raw id.
    renderPills({ collection: [{ itemId: 'mst_1' }] });
    expect(screen.getByTestId('tracker-field-pill-collection').textContent).toContain('Alpha Launch');
  });

  it('opens the collection picker under a field-name header', () => {
    renderPills({ collection: [] });

    fireEvent.click(screen.getByTestId('tracker-field-pill-collection'));

    expect(screen.getByTestId('tracker-field-popover-header-collection').textContent).toBe('Collection');
    screen.getByTestId('tracker-field-collection-picker');
  });

  it('saves the multi-value array shape the write path expects', () => {
    const { onSave } = renderPills({
      collection: [{ itemId: 'mst_1', title: 'Alpha Launch' }],
    });

    fireEvent.click(screen.getByTestId('tracker-field-pill-collection'));
    fireEvent.click(screen.getByTestId('tracker-field-collection-picker-option-rel_1'));

    expect(onSave).toHaveBeenCalledWith('collection', [
      expect.objectContaining({ itemId: 'mst_1' }),
      expect.objectContaining({
        itemId: 'rel_1',
        direction: 'out',
        relationshipTypeKey: 'in-collection',
      }),
    ]);
  });

  it('leaves non-collection relationship fields on the generic editor', () => {
    render(
      <TrackerFieldPills
        fields={[blockedByField]}
        values={{ blockedBy: [] }}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('tracker-field-pill-blockedBy'));

    expect(screen.queryByTestId('tracker-field-collection-picker')).toBeNull();
    screen.getByTestId('relationship-field-blockedBy');
  });
});
