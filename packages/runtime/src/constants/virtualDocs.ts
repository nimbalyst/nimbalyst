/**
 * Constants for virtual documents
 */

import type { VirtualDocumentDescriptor } from '../documents/virtualDocTypes';

export const VIRTUAL_DOC_PROTOCOL = 'virtual://';

export const VIRTUAL_DOCS: Record<string, VirtualDocumentDescriptor> = {
  WELCOME: {
    id: 'welcome',
    title: 'Welcome to Nimbalyst',
    assetPath: 'assets/welcome.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}welcome`,
  },
  PLANS: {
    id: 'plans',
    title: 'All Plans',
    assetPath: 'assets/plans.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}plans`,
  },
  TRACKER_BUGS: {
    id: 'tracker-bugs',
    title: 'Bugs',
    assetPath: 'assets/tracker-bugs.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}tracker-bugs`,
  },
  TRACKER_TASKS: {
    id: 'tracker-tasks',
    title: 'Tasks',
    assetPath: 'assets/tracker-tasks.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}tracker-tasks`,
  },
  TRACKER_IDEAS: {
    id: 'tracker-ideas',
    title: 'Ideas',
    assetPath: 'assets/tracker-ideas.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}tracker-ideas`,
  },
  TRACKER_ALL: {
    id: 'tracker-all',
    title: 'All Tracker Items',
    assetPath: 'assets/tracker-all.md',
    virtualPath: `${VIRTUAL_DOC_PROTOCOL}tracker-all`,
  },
};

/**
 * Check if a path is a virtual document
 */
export function isVirtualPath(path: string): boolean {
  return path.startsWith(VIRTUAL_DOC_PROTOCOL);
}

/**
 * Get virtual document descriptor by path
 */
export function getVirtualDocByPath(path: string): VirtualDocumentDescriptor | undefined {
  return Object.values(VIRTUAL_DOCS).find(doc => doc.virtualPath === path);
}

/**
 * Get virtual document descriptor by id
 */
export function getVirtualDocById(id: string): VirtualDocumentDescriptor | undefined {
  return Object.values(VIRTUAL_DOCS).find(doc => doc.id === id);
}