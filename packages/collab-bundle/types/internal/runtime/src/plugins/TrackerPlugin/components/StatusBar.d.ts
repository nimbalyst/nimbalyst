/**
 * Tracker header for full-document tracker items (a plan, a decision, ...).
 *
 * The document's frontmatter fields render as the same compact chip row every
 * other tracker surface uses, so a plan's status reads and edits identically
 * whether you're in the document or in Tracker Mode. The panel stays
 * collapsible, and the values still round-trip through frontmatter: `onChange`
 * receives one field at a time exactly as it did when this was a form.
 */
import React from 'react';
import type { TrackerDataModel } from '../../../../../tracker-schema/src/browser';
import type { TeamMemberOption } from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import './StatusBarSlider.css';
import './StatusBar.css';
export interface StatusBarProps {
    /** Show labels for values without a distinguishing option icon. */
    labelFields?: boolean;
    model: TrackerDataModel;
    data: Record<string, any>;
    onChange: (updates: Record<string, any>) => void;
    onClose?: () => void;
    trackerItemLink?: {
        label: string;
        title: string;
        onOpen: () => void;
    };
    teamMembers?: TeamMemberOption[];
    relationshipCandidates?: Map<string, RelationshipCandidate[]>;
    onOpenItem?: (itemId: string) => void;
    onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
}
export declare const StatusBar: React.FC<StatusBarProps>;
