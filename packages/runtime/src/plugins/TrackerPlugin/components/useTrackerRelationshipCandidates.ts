/**
 * Relationship targets for a tracker item's relationship fields.
 *
 * Shared so every field surface offers the same candidates: all loaded records
 * except the item itself, filtered by the field's allowed tracker types.
 */

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { isRelationshipField } from '../models';
import type { FieldDefinition } from '../models/TrackerDataModel';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsMapAtom } from '../trackerDataAtoms';
import { getRecordTitle } from '../trackerRecordAccessors';
import type { RelationshipCandidate } from './RelationshipFieldEditor';

export function useTrackerRelationshipCandidates(
  item: TrackerRecord | null | undefined,
  fields: FieldDefinition[],
): Map<string, RelationshipCandidate[]> {
  const itemsMap = useAtomValue(trackerItemsMapAtom);

  return useMemo(() => {
    const candidates = new Map<string, RelationshipCandidate[]>();
    if (!item) return candidates;
    for (const field of fields) {
      if (!isRelationshipField(field)) continue;
      const allowed = field.targetTrackerTypes;
      const values: RelationshipCandidate[] = [];
      for (const record of itemsMap.values()) {
        if (record.id === item.id) continue;
        if (allowed && allowed !== '*' && !allowed.includes(record.primaryType)) continue;
        values.push({
          itemId: record.id,
          title: getRecordTitle(record) || undefined,
          issueKey: record.issueKey || undefined,
          trackerType: record.primaryType,
        });
      }
      candidates.set(field.name, values);
    }
    return candidates;
  }, [fields, item, itemsMap]);
}
