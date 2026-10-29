// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  ISSUE_OVERLAY_TYPE,
  planIssueOverlayWrite,
  type IssueOverlayAction,
  type IssueOverlaySeed,
} from '../issues/issueOverlay';
import { PR_OVERLAY_TYPE, planPrReviewOverlayWrite, resolveReviewStatus, resolveStartedStatus } from '../prOverlay';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { globalRegistry } from '@nimbalyst/tracker-schema';

const SEED: IssueOverlaySeed = {
  issueUrl: 'https://github.com/nimbalyst/nimbalyst/issues/1187',
  issueNumber: 1187,
  title: 'Shared tracker rows briefly disappear on org switch',
  author: 'arivera',
  repo: 'nimbalyst/nimbalyst',
};

function record(overrides: Partial<TrackerRecord> & { id: string }): TrackerRecord {
  return {
    primaryType: ISSUE_OVERLAY_TYPE,
    typeTags: [overrides.primaryType ?? ISSUE_OVERLAY_TYPE],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/workspace', createdAt: '', updatedAt: '' },
    fields: {},
    ...overrides,
  };
}

function plan(
  action: IssueOverlayAction,
  updates: Record<string, unknown>,
  references: TrackerRecord[] = [],
) {
  return planIssueOverlayWrite({
    action,
    seed: SEED,
    references,
    updates,
    defaultStatus: 'untriaged',
  });
}

describe('github-issue overlay writes', () => {
  it('creates nothing for the actions that only look at an issue', () => {
    // The absence of an overlay is the product: an issue nobody formed an
    // opinion about must stay absent from the tracker no matter how often it
    // is selected, rendered, or opened on the Local tab.
    expect(plan('select-issue', {})).toBeNull();
    expect(plan('open-local-tab', {})).toBeNull();
    expect(plan('render-row', {})).toBeNull();
    // Even handed something to write, a read stays a read.
    expect(plan('open-local-tab', { status: 'ready' })).toBeNull();
  });

  it('creates the overlay on the first write, mirroring upstream fields once', () => {
    expect(plan('save-notes', { notes: 'Repro needs a second org' })).toEqual({
      kind: 'create',
      type: ISSUE_OVERLAY_TYPE,
      title: SEED.title,
      status: 'untriaged',
      priority: '',
      customFields: {
        issueUrl: SEED.issueUrl,
        issueNumber: 1187,
        author: 'arivera',
        repo: 'nimbalyst/nimbalyst',
        notes: 'Repro needs a second org',
      },
    });
    // Starting a session is a write here, unlike the PR side which never
    // auto-creates: handing an issue to an agent is the opinion being recorded.
    expect(plan('start-session', { status: 'investigating' })).toMatchObject({
      kind: 'create',
      status: 'investigating',
    });
  });

  it('reuses the overlay for the same issue rather than creating a second one', () => {
    // The stored URL differs cosmetically from the one the panel holds, and
    // the mirrored title is stale — both are true of an item `/investigate`
    // wrote earlier. Matching is by issue identity, not string equality.
    const existing = record({
      id: 'gi_01J8XQ',
      fields: {
        title: 'the title this issue had in June',
        status: 'investigating',
        issueUrl: 'https://GitHub.com/Nimbalyst/Nimbalyst/issues/1187#issuecomment-42',
      },
    });

    expect(plan('set-status', { status: 'ready' }, [existing])).toEqual({
      kind: 'update',
      itemId: 'gi_01J8XQ',
      // No title / author / repo: the overlay never re-syncs what GitHub owns,
      // which is why it cannot drift.
      updates: { status: 'ready' },
    });
  });

  it('refuses to move an adopted overlay back down the ladder', () => {
    // Adoption is the one escalation the design calls one-way. The ladder is
    // disabled once `adoptedItemId` exists, but `/investigate` and any future
    // caller reach the planner too, and an overlay left adopted-but-`ready`
    // reports itself as un-escalated in every pill and filter with nothing to
    // repair it — the panel no longer offers Adopt.
    const adopted = record({
      id: 'gi_01J8XQ',
      fields: {
        status: 'adopted',
        adoptedItemId: 'bug_77',
        issueUrl: SEED.issueUrl,
      },
    });

    expect(plan('set-status', { status: 'ready' }, [adopted])).toBeNull();
    // Only the status is frozen; triage notes and priority still land on it.
    expect(plan('save-notes', { notes: 'shipped in 0.74' }, [adopted])).toEqual({
      kind: 'update',
      itemId: 'gi_01J8XQ',
      updates: { notes: 'shipped in 0.74' },
    });
    // An overlay that merely reached `adopted` without the back-link was not
    // adopted — the back-link is what only adoption writes.
    const statusOnly = record({
      id: 'gi_02K9YR',
      fields: { status: 'adopted', issueUrl: SEED.issueUrl },
    });
    expect(plan('set-status', { status: 'ready' }, [statusOnly])).toMatchObject({
      kind: 'update',
    });
  });

  it('never writes triage state into an item of another type that links the issue', () => {
    // An adopted bug (or a legacy native bug carrying the GitHub link) shows in
    // the Local tab, but it runs its own ladder — `ready` means nothing there.
    const adoptedBug = record({
      id: 'bug_77',
      primaryType: 'bug',
      fields: { title: 'Org switch JWT race', status: 'in-progress', url: SEED.issueUrl },
    });

    expect(plan('set-status', { status: 'ready' }, [adoptedBug])).toMatchObject({
      kind: 'create',
    });
  });
});

describe('github-pr review overlay writes', () => {
  const prRecord = (status: string) =>
    record({ id: 'gp_1', primaryType: PR_OVERLAY_TYPE, typeTags: [PR_OVERLAY_TYPE], fields: { status } });

  it('reads the review status from the active schema and never reopens a finished PR', () => {
    loadBuiltinTrackers();
    globalRegistry.clearWorkspaceSchema(PR_OVERLAY_TYPE);
    expect(resolveReviewStatus()).toBe('reviewing');
    expect(planPrReviewOverlayWrite(null, 'reviewing')).toEqual({ status: 'reviewing' });
    expect(planPrReviewOverlayWrite(prRecord('to-review'), 'reviewing')).toEqual({ updates: { status: 'reviewing' } });
    expect(planPrReviewOverlayWrite(prRecord('merged'), 'reviewing')).toEqual({});
    expect(planPrReviewOverlayWrite(prRecord('closed'), 'reviewing')).toEqual({});

    // A workspace triage schema with uncategorised statuses (this repo's).
    const builtin = globalRegistry.get(PR_OVERLAY_TYPE)!;
    globalRegistry.register({
      ...builtin,
      fields: builtin.fields.map((field) => field.name !== 'status' ? field : {
        ...field,
        default: 'backlog',
        options: ['backlog', 'inspecting', 'needs-review', 'complete'].map((value) => ({ value, label: value })),
      }),
    });
    try {
      expect(resolveReviewStatus()).toBe('inspecting');
      expect(planPrReviewOverlayWrite(prRecord('backlog'), 'inspecting')).toEqual({ updates: { status: 'inspecting' } });
      expect(planPrReviewOverlayWrite(prRecord('complete'), 'inspecting')).toEqual({});
    } finally {
      globalRegistry.clearWorkspaceSchema(PR_OVERLAY_TYPE);
    }
  });
});

describe('github-issue investigate status', () => {
  it('uses investigating from the builtin and leaves a triage-only schema alone', () => {
    loadBuiltinTrackers();
    globalRegistry.clearWorkspaceSchema(ISSUE_OVERLAY_TYPE);
    const names = ['investigating', 'in-progress'];
    expect(resolveStartedStatus(ISSUE_OVERLAY_TYPE, names)).toBe('investigating');

    // This repo's triage schema has no investigating status and categorises none.
    const builtin = globalRegistry.get(ISSUE_OVERLAY_TYPE)!;
    globalRegistry.register({
      ...builtin,
      fields: builtin.fields.map((field) => field.name !== 'status' ? field : {
        ...field,
        default: 'needs-triage',
        options: ['needs-triage', 'keep-accept', 'close-fixed', 'needs-info'].map((value) => ({ value, label: value })),
      }),
    });
    try {
      expect(resolveStartedStatus(ISSUE_OVERLAY_TYPE, names)).toBeUndefined();
    } finally {
      globalRegistry.clearWorkspaceSchema(ISSUE_OVERLAY_TYPE);
    }
  });
});
