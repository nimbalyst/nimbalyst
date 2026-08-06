/**
 * Tracker Mode's focused document header binding for the shared metadata chips.
 *
 * The chip row, its editors, and the field-selection rules are shared (see
 * `TrackerFieldPills` / `useTrackerFieldLayout` in the runtime package). This
 * wrapper only supplies what is Electron-specific: the item from the store, the
 * workspace's team members, and the write path.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { TrackerFieldPills } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldPills';
import {
  isTrackerRecordEditable,
  useTrackerFieldLayout,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerFieldLayout';
import { useTrackerRelationshipCandidates } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/useTrackerRelationshipCandidates';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { useTrackerTeamMembers } from './useTrackerTeamMembers';
import { saveTrackerField } from './trackerFieldSave';
import { createCollectionItem } from './createCollectionItem';

interface TrackerDocumentFieldPillsProps {
  itemId: string;
  workspacePath?: string;
  onOpenItem?: (itemId: string) => void;
}

export const TrackerDocumentFieldPills: React.FC<TrackerDocumentFieldPillsProps> = ({
  itemId,
  workspacePath,
  onOpenItem,
}) => {
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const teamMembers = useTrackerTeamMembers(workspacePath);
  const fields = useTrackerFieldLayout(item?.primaryType ?? '');
  const relationshipCandidates = useTrackerRelationshipCandidates(item, fields);
  const editable = item ? isTrackerRecordEditable(item) : false;
  const values = useMemo(() => item?.fields ?? {}, [item]);

  const saveField = useCallback(async (fieldName: string, nextValue: unknown) => {
    if (!item || !editable) return;
    await saveTrackerField(item, fieldName, nextValue);
  }, [editable, item]);

  // Creating a collection from the chip assigns it through the normal field
  // save, so the collection's own members field is written by the standard
  // inverse-relationship propagation rather than by this surface.
  const createCollection = useCallback(async (title: string, type: string) => {
    if (!workspacePath) return null;
    return createCollectionItem({ workspacePath, type, title });
  }, [workspacePath]);

  if (!item) return null;

  return (
    <TrackerFieldPills
      fields={fields}
      values={values}
      editable={editable}
      teamMembers={teamMembers}
      relationshipCandidates={relationshipCandidates}
      onSave={saveField}
      onOpenItem={onOpenItem}
      onCreateCollection={createCollection}
      className="tracker-document-field-pills"
      testIdBase="tracker-document-field"
    />
  );
};
