/**
 * A Pages section's Types: every type in the section, as a map (a line
 * between types that relate, through relationship fields and page-link
 * relations) or as a table. A type opens its type page from either. "New
 * type..." opens the dialog the host renders (`renderNewType`). The host keeps
 * which view shows: the web console in the URL, the desktop in the tab.
 */
import React from 'react';
import type { PagesOpenOptions, PagesSearchLane } from './PagesSearchView';
export type PagesTypesViewMode = 'map' | 'table';
export interface PagesTypesViewProps {
    lane: PagesSearchLane;
    /** The project name, or a project switcher, in the header. */
    title?: React.ReactNode;
    /** The types placed in the section's tree, for the table's "In tree" column. */
    typePlacements: ReadonlyArray<{
        typeId: string;
    }>;
    view: PagesTypesViewMode;
    onViewChange: (view: PagesTypesViewMode) => void;
    /** `newTab`: Cmd/Ctrl was held on the click. */
    onOpenType: (typeId: string, options: PagesOpenOptions) => void;
    /** The New type dialog; absent hides the button (no tracker writes here). */
    renderNewType?: (props: {
        onClose: () => void;
        onCreated: (typeId: string) => void;
    }) => React.ReactNode;
}
export declare function PagesTypesView({ lane, title, typePlacements, view, onViewChange, onOpenType, renderNewType }: PagesTypesViewProps): React.JSX.Element;
