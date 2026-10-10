import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OLLAMA_DASHBOARD_DOM_SCRIPT,
  parseOllamaDashboardUsage,
  readOllamaDashboardDOM,
} from '../ollamaDashboardUsage';

const fixture = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ollama-settings-usage-synthetic.html'), 'utf8');
interface RawWindow { utilizationText: string; resetAt: string | null }
interface RawDashboard {
  creditBalanceText: string | null;
  planText: string | null;
  session: RawWindow | null;
  weekly: RawWindow | null;
  weeklyModels: { sourceLabel: string | null; rows: { nameText: string | null; countText: string | null }[] } | null;
}
const domFor = (html = fixture) => new DOMParser().parseFromString(html, 'text/html');
const rawFor = (doc: Document): RawDashboard => readOllamaDashboardDOM(doc) as RawDashboard;

describe('Ollama signed-in dashboard usage parser', () => {
  it('extracts the synthetic settings fixture and normalizes separate dashboard metrics', () => {
    const dom = domFor(fixture);
    const raw = rawFor(dom);
    const snapshot = parseOllamaDashboardUsage(raw);

    expect(raw).toMatchObject({
      creditBalanceText: '$0',
      planText: 'pro',
      session: { utilizationText: '12.5% used', resetAt: '2030-01-10T01:00:00Z' },
      weekly: { utilizationText: '62.5% used', resetAt: '2030-01-12T00:00:00Z' },
    });
    expect(snapshot).toEqual({
      creditBalanceUSD: 0,
      plan: 'pro',
      session: { utilization: 12.5, resetsAt: '2030-01-10T01:00:00Z', models: [], modelCountsAvailable: false },
      weekly: {
        utilization: 62.5,
        resetsAt: '2030-01-12T00:00:00Z',
        models: [
          { name: 'fixture-alpha', requestCount: 2 },
          { name: 'fixture-beta', requestCount: 7 },
          { name: 'fixture-gamma', requestCount: 11 },
          { name: 'fixture-delta', requestCount: 19 },
          { name: 'fixture-epsilon', requestCount: 23 },
          { name: 'fixture-zeta', requestCount: 31 },
        ],
        modelCountsAvailable: true,
      },
      modelCountsPeriod: 'this-week',
    });
  });

  it('owns the plan badge only through one Usage credits heading', () => {
    const missingHeaderDoc = domFor();
    const creditHeading = Array.from(missingHeaderDoc.querySelectorAll('#extra-usage h2'))
      .find(heading => heading.textContent?.startsWith('Usage credits'));
    creditHeading?.remove();
    const missingRaw = rawFor(missingHeaderDoc);
    expect(missingRaw.planText).toBeNull();
    expect(parseOllamaDashboardUsage(missingRaw)?.plan).toBeUndefined();

    const duplicateHeaderDoc = domFor();
    const original = Array.from(duplicateHeaderDoc.querySelectorAll('#extra-usage h2'))
      .find(heading => heading.textContent?.startsWith('Usage credits'));
    if (!original) throw new Error('fixture Usage credits heading is required');
    duplicateHeaderDoc.querySelector('#extra-usage')?.append(original.cloneNode(true));
    const duplicateRaw = rawFor(duplicateHeaderDoc);
    expect(duplicateRaw.planText).toBeNull();
    expect(parseOllamaDashboardUsage(duplicateRaw)?.plan).toBeUndefined();
  });

  it('does not return a snapshot when the plan is the only usable raw field', () => {
    expect(parseOllamaDashboardUsage({ planText: 'pro' })).toBeNull();
  });

  it('runs the serialized fixed extractor in a page-like context', () => {
    const dom = domFor(fixture);
    const serialized = new Function('document', `return ${OLLAMA_DASHBOARD_DOM_SCRIPT}`) as (document: Document) => unknown;
    expect(serialized(dom)).toEqual(readOllamaDashboardDOM(dom));
  });

  it('keeps valid partial utilization when reset is malformed and never borrows the other reset', () => {
    const html = fixture.replace('2030-01-10T01:00:00Z', 'next reset is unknown');
    const raw = rawFor(domFor(html));
    const snapshot = parseOllamaDashboardUsage(raw);
    expect(snapshot?.session).toMatchObject({ utilization: 12.5, resetsAt: null });
    expect(snapshot?.weekly?.resetsAt).toBe('2030-01-12T00:00:00Z');
  });

  it('omits ambiguous hidden or duplicate owned labels while retaining other metrics', () => {
    const hidden = fixture.replace('<div id="weekly-usage-models"', '<div hidden id="weekly-usage-models"');
    const hiddenSnapshot = parseOllamaDashboardUsage(rawFor(domFor(hidden)));
    expect(hiddenSnapshot?.weekly?.modelCountsAvailable).toBe(false);
    expect(hiddenSnapshot?.weekly?.utilization).toBe(62.5);

    const duplicate = fixture.replace('Session usage</span>', 'Session usage</span><span>Session usage</span>');
    const duplicateSnapshot = parseOllamaDashboardUsage(rawFor(domFor(duplicate)));
    expect(duplicateSnapshot?.session).toBeUndefined();
    expect(duplicateSnapshot?.weekly?.utilization).toBe(62.5);
  });

  it('rejects credit-as-spend text, out-of-range utilization and unsafe request counts', () => {
    const base = rawFor(domFor());
    expect(parseOllamaDashboardUsage({ ...base, creditBalanceText: 'Spent $12.00' })?.creditBalanceUSD).toBeUndefined();
    expect(parseOllamaDashboardUsage({ ...base, session: { utilizationText: '101% used', resetAt: '2030-01-10T01:00:00Z' } })?.session).toBeUndefined();
    const unsafe = structuredClone(base);
    if (!unsafe.weeklyModels) throw new Error('fixture weekly model section is required');
    unsafe.weeklyModels.rows[0].countText = '9007199254740992 requests';
    expect(parseOllamaDashboardUsage(unsafe)?.weekly).toMatchObject({ utilization: 62.5, modelCountsAvailable: false, models: [] });
    expect(parseOllamaDashboardUsage(unsafe)?.modelCountsPeriod).toBeUndefined();
  });

  it('does not treat a changed source label or duplicate models as an available breakdown', () => {
    const base = rawFor(domFor());
    expect(parseOllamaDashboardUsage({ ...base, weeklyModels: { ...base.weeklyModels, sourceLabel: 'Models used in last 7 days' } })?.weekly)
      .toMatchObject({ utilization: 62.5, modelCountsAvailable: false, models: [] });
    const duplicate = structuredClone(base);
    if (!duplicate.weeklyModels) throw new Error('fixture weekly model section is required');
    duplicate.weeklyModels.rows[1].nameText = duplicate.weeklyModels.rows[0].nameText;
    expect(parseOllamaDashboardUsage(duplicate)?.weekly).toMatchObject({ modelCountsAvailable: false, models: [] });
  });

  it('distinguishes an explicit empty weekly breakdown from missing source data', () => {
    const base = rawFor(domFor());
    const empty = parseOllamaDashboardUsage({ ...base, weeklyModels: { sourceLabel: 'Models used this week', rows: [] } });
    expect(empty?.weekly).toMatchObject({ modelCountsAvailable: true, models: [] });
    expect(empty?.modelCountsPeriod).toBe('this-week');
    expect(parseOllamaDashboardUsage({ ...base, weeklyModels: null })?.weekly?.modelCountsAvailable).toBe(false);
  });

  it('fails closed when the page exceeds the bounded node scan', () => {
    const oversized = `${fixture}<div>${'<i></i>'.repeat(11000)}</div>`;
    expect(readOllamaDashboardDOM(domFor(oversized))).toBeNull();
  });

  it('rejects excessive nesting deterministically without depending on elapsed time', () => {
    const doc = domFor();
    let parent: Element = doc.body;
    for (let index = 0; index < 300; index++) {
      const child = doc.createElement('div');
      parent.appendChild(child);
      parent = child;
    }
    parent.appendChild(doc.createElement('span')).textContent = 'irrelevant';
    expect(readOllamaDashboardDOM(doc)).toBeNull();
  });

  it('keeps valid utilization when the exact window has no reset timer', () => {
    const doc = domFor();
    doc.querySelector('[data-time="2030-01-10T01:00:00Z"]')?.remove();
    const snapshot = parseOllamaDashboardUsage(rawFor(doc));
    expect(snapshot?.session).toMatchObject({ utilization: 12.5, resetsAt: null });
    expect(snapshot?.weekly?.resetsAt).toBe('2030-01-12T00:00:00Z');
  });

  it('accepts singular and grouped request counts only when the numeric value is safe', () => {
    const base = rawFor(domFor());
    const rows = base.weeklyModels?.rows ?? [];
    rows[0] = { nameText: 'solo', countText: '1 request' };
    rows[1] = { nameText: 'grouped', countText: '1,234 requests' };
    const snapshot = parseOllamaDashboardUsage({ ...base, weeklyModels: { sourceLabel: 'Models used this week', rows } });
    expect(snapshot?.weekly?.models.slice(0, 2)).toEqual([
      { name: 'solo', requestCount: 1 },
      { name: 'grouped', requestCount: 1234 },
    ]);
  });
});
