/**
 * "New type..." for Pages: names, an icon, a few fields and an optional
 * parent, written as the same schema `tracker_define_type` writes, in the
 * section the dialog was opened from. The host owns the write (`defineType`);
 * this dialog then places the type in the tree, at the section root or under
 * the page it was opened from, so it shows up and Set type can use it.
 */
import React from 'react';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
import type { CollabTypeLane } from '../docs/collabTypeResolver';
import type { CollabDocsSession } from '../docs/session';
import type { SharedParentKind } from '../docs/types';
import { type NewTypeSchema } from '../docs/newTypeSchema';
export interface NewTypeDialogProps {
    lane: CollabTypeLane;
    /** The section's types: parent and relation choices, and the collision check. */
    resolver: CollabTypeTreeResolver;
    session: CollabDocsSession;
    /** Where the new type is placed; null or omitted is the section root. */
    parent?: {
        id: string;
        kind: SharedParentKind;
    } | null;
    /**
     * The host's write. Rejects with a message a person can read. `syncing` means
     * it is written here but the team's server has not confirmed it yet.
     */
    defineType: (schema: NewTypeSchema) => Promise<void | {
        status: 'syncing';
    }>;
    onCreated?: (typeId: string) => void;
    onClose: () => void;
}
export declare function NewTypeDialog({ lane, resolver, session, parent, defineType, onCreated, onClose }: NewTypeDialogProps): React.ReactPortal;
