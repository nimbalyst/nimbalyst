/**
 * The Trash row at the foot of a Pages section, and the Trash it opens. Every
 * delete in Pages (the tree, the agent's delete, the web console) moves a page
 * here; this is where a person gets it back. The dialog loads lazily, keeping
 * it out of the docs-ui eager bundle.
 */
import React from 'react';
export declare const CollabSidebarTrashEntry: React.FC<{
    sectionLabel: string;
}>;
