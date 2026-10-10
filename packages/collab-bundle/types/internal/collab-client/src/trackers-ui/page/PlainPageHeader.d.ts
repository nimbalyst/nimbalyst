/**
 * The top of a plain page, laid out like a typed page's: the title, then the
 * same type row (`TrackerTypeRow`). A plain page's type is "Page", with its
 * own small set of fields (`pageFields.ts`: status, owner, summary) kept on
 * the document. The "Page" chip offers another type through Set type.
 *
 * Presentational: the host saves the title and fields and runs Set type.
 */
import React from 'react';
import type { TeamMemberOption } from '../../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
import { type PageFields } from '../../docs/pageFields';
import { type PageFact } from './PageFacts';
import './TrackerPageView.css';
export interface PlainPageHeaderProps {
    title: string;
    editable: boolean;
    /** Called once the title is committed (Enter or blur), only when it changed. */
    onRename?: (title: string) => void;
    /** Absent where the page cannot get a type here. */
    onSetType?: () => void;
    /** Read-only facts at the end of the row (updated, created). */
    facts?: readonly PageFact[];
    /** The page's own fields. */
    fields?: PageFields;
    /** Saves one field; null clears it. Absent where fields can't be written. */
    onUpdateField?: (name: keyof PageFields, value: unknown) => void;
    teamMembers?: TeamMemberOption[];
}
export declare const PlainPageHeader: React.FC<PlainPageHeaderProps>;
