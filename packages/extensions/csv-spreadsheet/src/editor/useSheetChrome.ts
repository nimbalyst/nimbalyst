/**
 * Phase 3 formatting and layout, bundled for the grid shell: paint lookups,
 * format actions, row layout, zoom, validation interactions, and the open
 * state of the conditional-format panel and validation dialog.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { rangeKeyOf } from '../cells/cellStyles';
import { setValidationRule } from '../validation/entry';
import { findValidationRule } from '../validation/validate';
import type { ValidationRule } from '../validation/types';
import type { ConditionalFormat } from '../conditional/types';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import { useSheetPaint } from './useSheetPaint';
import { useFormatActions } from './useFormatActions';
import { useRowLayout } from './useRowLayout';
import { useValidationUi } from './useValidationUi';
import { beginCellEdit } from './beginCellEdit';

export function useSheetChrome(
  core: EditorCore,
  metadata: SpreadsheetMetadata,
  rowView: Pick<RowView, 'translateRowIndex' | 'toVisibleRow' | 'invalidateRowView'>,
  enabled: boolean,
) {
  const [zoom, setZoom] = useState(1);
  core.zoomRef.current = zoom;
  const paint = useSheetPaint(core, metadata);
  const actions = useFormatActions(core);
  const { rowHeaders } = useRowLayout(core, metadata, paint, rowView, enabled, zoom);
  const validationUi = useValidationUi(core, enabled);
  const [conditionalOpen, setConditionalOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [namedRangesOpen, setNamedRangesOpen] = useState(false);

  // Hidden rows are trimmed with the filter; a change from a collaborator (or
  // a load) has to re-derive the trimmed set, which a local command does in
  // its own afterWrite.
  const { invalidateRowView } = rowView;
  useEffect(() => {
    if (enabled) void invalidateRowView();
  }, [enabled, metadata.hiddenRows, invalidateRowView]);

  const insertFunction = useCallback((name: string) => {
    beginCellEdit(core, rowView.toVisibleRow, `=${name}(`);
  }, [core, rowView.toVisibleRow]);

  const setConditionalFormats = useCallback((conditionalFormats: ConditionalFormat[]) => {
    actions.applyMeta(() => ({ conditionalFormats }));
  }, [actions]);

  const target = actions.target();
  const selectionKey = target ? rangeKeyOf(target.range) : '';
  const currentRule: ValidationRule | null = target
    ? findValidationRule(metadata.validation, target.active.row, target.active.col)?.rule ?? null
    : null;
  const saveValidation = useCallback((rule: ValidationRule | null) => {
    actions.apply((meta, range) => ({ validation: setValidationRule(meta.validation, range, rule) }));
  }, [actions]);

  return {
    zoom, setZoom, paint, actions, rowHeaders, validationUi,
    conditionalOpen, setConditionalOpen, setConditionalFormats,
    validationOpen, setValidationOpen, saveValidation, currentRule, selectionKey,
    namedRangesOpen, setNamedRangesOpen,
    insertFunction,
  };
}

export type SheetChrome = ReturnType<typeof useSheetChrome>;
