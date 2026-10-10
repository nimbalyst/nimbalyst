/**
 * RevoGrid cell editors for the tracker grid, one per schema field type.
 *
 * Each editor is built as an `EditorCtrCallable` factory so the field's options
 * (select choices, relationship candidates, number bounds) are captured in a
 * closure -- RevoGrid hands the editor only the cell model, not our schema.
 *
 * Editors return the *raw* editor value; `coerceCellValue` in the runtime
 * package converts it to storage shape when the grid commits the edit.
 */
import type { EditorCtr, EditCell } from '@revolist/revogrid';
import type { CellEditorDescriptor } from '../../../../runtime/src/plugins/TrackerPlugin/components/trackerCellEditors';
import type { TeamMemberOption } from '../../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
/** A tracker item the relationship editor can target. */
export interface RelationshipCandidate {
    itemId: string;
    issueKey?: string;
    title: string;
    trackerType: string;
}
export interface TrackerEditorContext {
    /** Candidates for relationship cells, narrowed by the field's target types. */
    relationshipCandidates?: () => RelationshipCandidate[];
    /** Who a `user` cell can name; without any, the cell is free text. */
    teamMembers?: () => readonly TeamMemberOption[];
}
/**
 * Shared key handling: Enter commits and advances one row, Tab/Shift+Tab commit
 * and let RevoGrid move horizontally, and Escape abandons the edit. Arrow keys
 * remain available to the active input/select instead of unexpectedly committing.
 */
export declare function commitOnNavigationKeys(e: KeyboardEvent, getValue: () => unknown, save: (value: unknown, preventFocus?: boolean) => void, close: (focusNext?: boolean) => void): void;
/**
 * Build the RevoGrid editor for a resolved cell-editor descriptor.
 * Returns `undefined` for readonly cells so RevoGrid never enters edit mode.
 */
export declare function createTrackerCellEditor(descriptor: CellEditorDescriptor, context?: TrackerEditorContext): EditorCtr | undefined;
/**
 * Resolve an editor from the row being edited. Mixed-type grids cannot choose a
 * single schema descriptor at column-construction time, because the same role
 * may map to differently named fields and option sets on each row.
 */
export declare function createRowAwareTrackerCellEditor(resolveDescriptor: (editCell: EditCell | undefined) => CellEditorDescriptor, context?: TrackerEditorContext): EditorCtr;
