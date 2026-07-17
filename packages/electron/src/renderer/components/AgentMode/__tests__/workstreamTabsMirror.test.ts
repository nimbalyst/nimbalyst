import { describe, expect, it } from 'vitest';
import { shouldSkipResourceMirror } from '../workstreamTabsMirror';

// Pins the persist-effect guard in WorkstreamEditorTabs (NIM-1680).
//
// Mount sequence when a tracker pill is clicked while the workstream is in
// transcript layout: App seeds openResources with the tracker and flips
// layout to 'split'; WorkstreamEditorTabs mounts; its restore effect seeds
// TabsContext (an async state update) and marks restore done; the persist
// effect then runs IN THE SAME FLUSH with the still-empty tabs array. If it
// mirrors that transient [] into openResources, workstreamHasOpenResources
// flips false and AgentWorkstreamPanel's auto-collapse effect reverts the
// layout to 'transcript' — the tab flashes and closes. React 19's effect
// scheduling made the collapse reliably observe the empty intermediate state
// (on 18 the re-mirror usually won the race).
//
// The guard: while restore-seeded tabs have not yet materialized in
// TabsContext, an empty tab set must NOT be mirrored. Once the seeds land
// (or there were none), empty mirrors are legitimate last-tab-closed writes.
describe('shouldSkipResourceMirror', () => {
  it('skips the empty mirror while restore seeds have not materialized', () => {
    expect(shouldSkipResourceMirror({ pendingSeedCount: 1, tabCount: 0 })).toBe(true);
    expect(shouldSkipResourceMirror({ pendingSeedCount: 3, tabCount: 0 })).toBe(true);
  });

  it('mirrors once the seeded tabs have landed', () => {
    expect(shouldSkipResourceMirror({ pendingSeedCount: 1, tabCount: 1 })).toBe(false);
    expect(shouldSkipResourceMirror({ pendingSeedCount: 3, tabCount: 3 })).toBe(false);
  });

  it('mirrors an empty set when nothing was seeded (fresh workstream)', () => {
    expect(shouldSkipResourceMirror({ pendingSeedCount: 0, tabCount: 0 })).toBe(false);
  });

  it('mirrors an empty set after seeds landed and user closed the last tab', () => {
    // The component clears pendingSeedCount when tabs first materialize, so a
    // later legitimate empty write presents as pendingSeedCount 0.
    expect(shouldSkipResourceMirror({ pendingSeedCount: 0, tabCount: 0 })).toBe(false);
  });
});
