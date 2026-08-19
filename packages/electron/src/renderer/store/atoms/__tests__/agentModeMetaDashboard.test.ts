// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  agentModeLayoutAtomFamily,
  mergeWithDefaults,
  metaAgentDashboardCollapsedAtom,
  toggleMetaAgentDashboardCollapsedAtom,
} from '../agentMode';
import { activeWorkspacePathAtom } from '../openProjects';

// NIM-3087: on a narrow/vertical window the meta-agent "Delegated Sessions"
// pane must be foldable, and the choice has to survive a reload.
describe('meta-agent dashboard collapse', () => {
  it('defaults to expanded and flips on toggle', () => {
    const store = createStore();
    const workspacePath = '/tmp/meta-agent-workspace';
    store.set(activeWorkspacePathAtom, workspacePath);

    expect(store.get(metaAgentDashboardCollapsedAtom)).toBe(false);

    store.set(toggleMetaAgentDashboardCollapsedAtom);
    expect(store.get(metaAgentDashboardCollapsedAtom)).toBe(true);
    expect(store.get(agentModeLayoutAtomFamily(workspacePath)).metaAgentDashboardCollapsed).toBe(true);

    store.set(toggleMetaAgentDashboardCollapsedAtom);
    expect(store.get(metaAgentDashboardCollapsedAtom)).toBe(false);
  });

  it('restores a persisted collapsed state and defaults when the field is absent', () => {
    expect(mergeWithDefaults({ metaAgentDashboardCollapsed: true }).metaAgentDashboardCollapsed).toBe(true);
    expect(mergeWithDefaults({}).metaAgentDashboardCollapsed).toBe(false);
  });
});
