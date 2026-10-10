/**
 * The list a select or people field picks from: a field chip's popover and a
 * table cell's both draw it, so a choice looks the same wherever it is made.
 */
import React from 'react';
import type { TeamMemberOption } from './TrackerFieldEditor';
import './TrackerFieldPills.css';
export interface TrackerFieldChoice {
    value: string;
    label: string;
    icon?: string;
    color?: string;
    /** Draws the person's avatar in place of an icon. */
    avatarIdentity?: string;
}
/** A `user` field stores the member's email and shows their name. */
export declare function teamMemberChoices(members: readonly TeamMemberOption[]): TrackerFieldChoice[];
export declare const TrackerFieldChoiceList: React.FC<{
    choices: readonly TrackerFieldChoice[];
    value: unknown;
    /** Offers "None", which picks `''`. */
    allowNone: boolean;
    onPick: (value: string) => void;
    /** The choice a keyboard is on, when the keys stay in a filter input (`''` is "None"). */
    activeValue?: string;
    testId?: string;
}>;
