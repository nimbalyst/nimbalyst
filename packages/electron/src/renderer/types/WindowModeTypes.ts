/**
 * Window Mode System Types
 *
 * Defines content modes available in workspace windows.
 * Each component manages its own state - this just tracks which mode is active.
 */

/**
 * Content modes available in workspace windows
 * - files: File tree and editor tabs
 * - manage: Workspace artifact browser and editor
 * - agent: Agentic coding panel
 * - tracker: Tracker (bug/decision) items view
 * - collab: Shared documents
 * - pr-review: GitHub pull request review panel (issue #307)
 * - settings: Settings view
 */
export type ContentMode = 'files' | 'manage' | 'agent' | 'tracker' | 'collab' | 'pr-review' | 'settings';
