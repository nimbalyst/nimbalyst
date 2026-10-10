/**
 * Field editing for one tracker item: the title and every schema field, with
 * per-field debounced saves and reconciliation against external writes.
 * Shared by `TrackerItemDetail` and the Pages-mode `TrackerPageView`, so a
 * title or chip edit takes the same write path on both.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { FieldDefinition, TrackerSharing } from '@nimbalyst/tracker-schema';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { reconcileExternalFieldChanges } from './trackerDetailFieldSync';
import { isLocalWikiRecord } from '../../services/localWikiTrackerRecords';
import { saveLocalWikiItemFields } from '../../services/localWikiTrackerWrites';

export interface UseTrackerItemFieldsOptions {
  itemId: string;
  item: TrackerRecord | null | undefined;
  editable: boolean;
  sharing: TrackerSharing;
  /** Called after a field save re-indexed the item's relationships. */
  onRelationshipsReindexed?: () => void;
}

export function useTrackerItemFields({
  itemId,
  item,
  editable,
  sharing,
  onRelationshipsReindexed,
}: UseTrackerItemFieldsOptions) {
  const onReindexedRef = useRef(onRelationshipsReindexed);
  onReindexedRef.current = onRelationshipsReindexed;

  // Local state for text fields (debounced save)
  const [localTitle, setLocalTitle] = useState(item ? getRecordTitle(item) : '');
  const [localCustomFields, setLocalCustomFields] = useState<Record<string, any>>({});
  // Per-field debounce timers (not one shared timer) so editing one field never
  // drops another field's pending save, and so reconciliation can tell which
  // fields are mid-edit. `pendingFieldsRef` holds fields with an unflushed save;
  // `externalFieldBaselineRef` is the last-reconciled snapshot of persisted
  // values used to detect external writes (NIM-790).
  const fieldSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingFieldsRef = useRef<Set<string>>(new Set());
  const externalFieldBaselineRef = useRef<Record<string, unknown>>({});

  // Reset local editing state when navigating to a different item.
  // We don't sync on item data changes (saves) to avoid clobbering in-progress text.
  useEffect(() => {
    if (!item) return;
    setLocalTitle(getRecordTitle(item));
    setLocalCustomFields({});
    // Clear any stale per-field debounce timers from the previous item and seed
    // the reconciliation baseline with the new item's persisted fields.
    for (const timer of fieldSaveTimersRef.current.values()) clearTimeout(timer);
    fieldSaveTimersRef.current.clear();
    pendingFieldsRef.current.clear();
    externalFieldBaselineRef.current = { ...item.fields };
  }, [itemId]); // itemId only -- not item fields

  // Reconcile in-progress field overrides against external writes (MCP, sync,
  // another window). When a field the user is NOT actively editing changes
  // underneath us, drop the stale local override so the panel shows -- and
  // saves -- the fresh value instead of clobbering it (NIM-790).
  const itemFields = item?.fields;
  useEffect(() => {
    if (!itemFields) return;
    const baseline = externalFieldBaselineRef.current;
    externalFieldBaselineRef.current = { ...itemFields };
    setLocalCustomFields((prev) => {
      const overriddenFields = Object.keys(prev);
      if (overriddenFields.length === 0) return prev;
      const { clearedFields } = reconcileExternalFieldChanges({
        previousPersisted: baseline,
        currentPersisted: itemFields,
        overriddenFields,
        pendingFields: pendingFieldsRef.current,
      });
      if (clearedFields.length === 0) return prev;
      const next = { ...prev };
      for (const f of clearedFields) delete next[f];
      return next;
    });
  }, [itemFields]);

  /** Save a field update -- routes to file-based save for file-backed items, DB for native */
  const saveField = useCallback(async (updates: Record<string, any>) => {
    if (!editable || !item) return;
    try {
      if (isLocalWikiRecord(item)) {
        // A Local wiki item is a file; the wiki library writes it and reports a failure.
        await saveLocalWikiItemFields(item, updates);
        return;
      }
      if ((item.source === 'frontmatter' || item.source === 'import' || item.source === 'inline') && item.system.documentPath) {
        // File-backed items with a real document path: update in source file
        await window.electronAPI.documentService.updateTrackerItemInFile({
          itemId: item.id,
          updates,
        });
      } else {
        // Native DB items, or file-backed items whose document_path is missing/empty
        await window.electronAPI.documentService.updateTrackerItem({
          itemId: item.id,
          updates,
          sharing,
        });
      }
      // Refresh the derived relationship index for this item (Epic C Phase 2) so
      // backlinks stay current after a relationship field edit. Fire-and-forget,
      // idempotent; harmless for non-relationship field saves.
      window.electronAPI
        .invoke('document-service:tracker-item-reindex-relationships', { itemId: item.id }).then(() => onReindexedRef.current?.())
        .catch(() => {});
    } catch (err) {
      console.error('[TrackerItemDetail] Failed to save field:', err);
    }
  }, [item?.id, item?.source, editable, sharing]);

  /** Debounced save for a single text field. Per-field timers + pending-field
   *  tracking let the reconciliation effect distinguish "user is editing this
   *  field" from "external write landed" (NIM-790). */
  const debouncedSaveField = useCallback((fieldName: string, value: any) => {
    pendingFieldsRef.current.add(fieldName);
    const timers = fieldSaveTimersRef.current;
    const existing = timers.get(fieldName);
    if (existing) clearTimeout(existing);
    timers.set(fieldName, setTimeout(async () => {
      timers.delete(fieldName);
      try {
        await saveField({ [fieldName]: value });
      } finally {
        pendingFieldsRef.current.delete(fieldName);
      }
    }, 500));
  }, [saveField]);

  // Cleanup timers
  useEffect(() => {
    const timers = fieldSaveTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** Handle immediate field change (selects, checkboxes) */
  const handleImmediateFieldChange = useCallback((fieldName: string, value: any) => {
    saveField({ [fieldName]: value });
  }, [saveField]);

  /** Handle debounced text field change */
  const handleTextFieldChange = useCallback((fieldName: string, value: any) => {
    if (fieldName === 'title') {
      setLocalTitle(value);
    } else {
      setLocalCustomFields(prev => ({ ...prev, [fieldName]: value }));
    }
    debouncedSaveField(fieldName, value);
  }, [debouncedSaveField]);

  /** Get field value -- use in-progress local state for text fields, atom for select/etc */
  const getFieldValue = useCallback((fieldName: string): any => {
    if (!item) return undefined;
    // For text-like fields being edited, localCustomFields holds the in-progress value.
    // handleTextFieldChange stores owner (and other string fields) in localCustomFields,
    // so we must check it first to avoid resetting input on each keystroke.
    if (fieldName in localCustomFields) return localCustomFields[fieldName];
    // All fields are now in record.fields (schema-driven)
    return item.fields[fieldName];
  }, [item, localCustomFields]);

  /** Determine whether a field change should be immediate or debounced */
  const handleFieldChange = useCallback((field: FieldDefinition, value: any) => {
    const isTextLike = field.type === 'string' || field.type === 'text' || field.type === 'user';
    if (isTextLike) {
      handleTextFieldChange(field.name, value);
    } else {
      handleImmediateFieldChange(field.name, value);
    }
  }, [handleTextFieldChange, handleImmediateFieldChange]);

  /** Field values with any in-progress local edit applied. */
  const storedValues = useMemo(() => ({ ...(item?.fields ?? {}), ...localCustomFields }), [item?.fields, localCustomFields]);

  return {
    localTitle,
    storedValues,
    handleTextFieldChange,
    handleFieldChange,
    getFieldValue,
  };
}
