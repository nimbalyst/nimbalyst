// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planConsoleLinkOpen, trackerReferenceLinkFor, type ConsoleLinkOpenContext } from '../consoleLinkPlan';

const ORIGIN = 'https://console.nimbalyst.com';
const ctx: ConsoleLinkOpenContext = {
  team: { orgId: 'org-1', teamProjectId: 'tp-1' },
  resolveItem: (ref) => (ref === 'NIM-1' ? 'item-1' : ref === 'tk_9' ? 'item-9' : null),
};

describe('planConsoleLinkOpen', () => {
  it.each([
    [`${ORIGIN}/org/org-1/project/tp-1/document/doc-1`, { action: 'team-document', documentId: 'doc-1' }],
    [`${ORIGIN}/org/org-1/project/tp-1/document/doc-1?comment=c-1`, { action: 'team-document', documentId: 'doc-1' }],
    [`${ORIGIN}/org/org-1/project/tp-1/trackers/item/NIM-1`, { action: 'item', itemId: 'item-1' }],
    [`${ORIGIN}/org/org-1/project/tp-1/trackers/type/bug`, { action: 'type', typeId: 'bug', personal: false }],
    [`${ORIGIN}/org/org-1/project/tp-1/view/type/bug`, { action: 'type', typeId: 'bug', personal: false }],
    [`${ORIGIN}/app/page/p-1`, { action: 'personal-page', pageId: 'p-1' }],
    [`${ORIGIN}/app/item/tk_9`, { action: 'item', itemId: 'item-9' }],
    [`${ORIGIN}/app/type/idea`, { action: 'type', typeId: 'idea', personal: true }],
    [`${ORIGIN}/app/cite/s-1/answer/toolu_1`, { action: 'session', sessionId: 's-1' }],
    // A Claude Code session is not a Nimbalyst session; the console page explains where it lives.
    [`${ORIGIN}/app/cite/claude-code/cc-1/prompt/u-1`, { action: 'browser' }],
  ])('opens %s in the app', (url, plan) => {
    expect(planConsoleLinkOpen(url, ctx)).toEqual(plan);
  });

  it('leaves team links for another team, project or no team to the browser', () => {
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-2/project/tp-1/document/doc-1`, ctx)).toEqual({ action: 'browser' });
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-1/project/tp-2/trackers/type/bug`, ctx)).toEqual({ action: 'browser' });
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-1/project/tp-1/document/doc-1`, { ...ctx, team: null })).toEqual({ action: 'browser' });
  });

  it('says why a link it cannot open in the app is not opened anywhere', () => {
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-1/project/tp-1/trackers/item/NIM-404`, ctx))
      .toEqual({ action: 'missing', what: 'page' });
    expect(planConsoleLinkOpen(`${ORIGIN}/app/item/NIM-404`, ctx)).toEqual({ action: 'missing', what: 'page' });
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-1/project/tp-1/view/marks?kind=open`, ctx)).toEqual({ action: 'browser' });
  });

  it('ignores anything that is not a console link', () => {
    expect(planConsoleLinkOpen('https://example.com/a', ctx)).toBeNull();
    expect(planConsoleLinkOpen(`${ORIGIN}/org/org-1/admin`, ctx)).toBeNull();
  });
});

describe('trackerReferenceLinkFor', () => {
  const team = { orgId: 'org-1', teamProjectId: 'tp-1' };

  it('links a team item, or one this window does not know, through the team', () => {
    expect(trackerReferenceLinkFor('NIM-1', team, { syncStatus: 'synced' }))
      .toBe(`${ORIGIN}/org/org-1/project/tp-1/page/item/NIM-1`);
    expect(trackerReferenceLinkFor('NIM-1', team, null)).toBe(`${ORIGIN}/org/org-1/project/tp-1/page/item/NIM-1`);
  });

  it('links a personal item, or any item without a team, locally', () => {
    expect(trackerReferenceLinkFor('NIM.4', team, { syncStatus: 'local' })).toBe(`${ORIGIN}/app/item/NIM.4`);
    expect(trackerReferenceLinkFor('NIM-1', null, { syncStatus: 'synced' })).toBe(`${ORIGIN}/app/item/NIM-1`);
  });
});
