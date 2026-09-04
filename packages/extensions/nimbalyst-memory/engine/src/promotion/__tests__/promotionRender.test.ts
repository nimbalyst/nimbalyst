// @vitest-environment node
/**
 * The signal has to be right because it is what a person decides on, and the
 * rendered file has to be right because it lands in a repository under review.
 *
 * Deliberately not snapshotted: a snapshot of the whole body churns on every
 * wording change and trains the next person to regenerate it without reading
 * it, which is the opposite of what a review gate is for. The assertions below
 * pin the properties that would be a defect — a tracker key reaching the file,
 * malformed frontmatter, a headline claiming a contradicted memory is clean.
 */
import { describe, expect, it } from 'vitest';

import { computePromotionSignal, DEFAULT_PROMOTION_THRESHOLDS } from '../signal.js';
import { renderRuleMarkdown, ruleFileNameFor } from '../render.js';
import { assertNoTrackerKeys, stripTrackerKeys } from '../provenance.js';
import type { PromotableMemory } from '../types.js';

const AT = new Date('2026-09-03T18:00:00Z');

const memory = (overrides: Partial<PromotableMemory> = {}): PromotableMemory => ({
  id: 'mem_01',
  title: 'Never Read API Keys From the Environment',
  body: 'API keys must come only from values the user explicitly configured in settings. There is no `process.env` fallback in the provider auth path.',
  why: 'A user had an unrelated key in a `.env` file; it was picked up silently and billed to their personal account.',
  recall: { recallCount: 14, sessionCount: 6, lastRecalledAt: '2026-09-01T10:00:00Z' },
  ...overrides,
});

describe('computePromotionSignal', () => {
  it('reports usage and clean standing for a memory that earned its keep', () => {
    const signal = computePromotionSignal(memory());

    expect(signal.eligible).toBe(true);
    expect(signal.blockers).toEqual([]);
    expect(signal.headline).toBe('Recalled 14 times across 6 sessions and never contradicted.');
    expect(signal.strength).toBeGreaterThan(0);
  });

  it('blocks a contradicted memory however often it was recalled', () => {
    // The trap this exists for: a wrong memory that keeps being retrieved looks
    // *more* promotable by volume alone.
    const signal = computePromotionSignal(
      memory({ recall: { recallCount: 90, sessionCount: 40 }, standing: { contradictedBy: ['m2'] } }),
    );

    expect(signal.eligible).toBe(false);
    expect(signal.strength).toBe(0);
    expect(signal.headline).not.toContain('never contradicted');
    expect(signal.blockers.join(' ')).toContain('Contradicted by 1 later memory');
  });

  it('blocks a superseded memory and points at its replacement', () => {
    const signal = computePromotionSignal(memory({ standing: { supersededBy: 'mem_02' } }));

    expect(signal.eligible).toBe(false);
    expect(signal.blockers.join(' ')).toContain('Superseded');
  });

  it('names both thresholds a thin memory misses, and never-recalled separately', () => {
    const thin = computePromotionSignal(memory({ recall: { recallCount: 2, sessionCount: 1 } }));
    expect(thin.eligible).toBe(false);
    expect(thin.blockers.join(' ')).toContain(`under the ${DEFAULT_PROMOTION_THRESHOLDS.minRecallCount}`);
    expect(thin.blockers.join(' ')).toContain(`under the ${DEFAULT_PROMOTION_THRESHOLDS.minSessionCount}`);

    const unused = computePromotionSignal(memory({ recall: undefined }));
    expect(unused.eligible).toBe(false);
    expect(unused.headline).toBe('Never recalled.');
    expect(unused.blockers.join(' ')).toContain('No recall history');
  });

  it('ranks by strength but saturates, so one hot memory cannot own the queue', () => {
    const modest = computePromotionSignal(memory({ recall: { recallCount: 6, sessionCount: 4 } }));
    const heavy = computePromotionSignal(memory({ recall: { recallCount: 40, sessionCount: 20 } }));
    const absurd = computePromotionSignal(memory({ recall: { recallCount: 4000, sessionCount: 900 } }));

    expect(heavy.strength).toBeGreaterThan(modest.strength);
    expect(absurd.strength).toBe(1);
    expect(heavy.strength).toBeLessThanOrEqual(1);
  });
});

describe('renderRuleMarkdown', () => {
  it('writes a rule in the shape of the directory it joins', () => {
    const signal = computePromotionSignal(memory());
    const { fileName, contents, warnings } = renderRuleMarkdown(
      memory({
        appliesTo: ['packages/runtime/src/ai/**/*.ts', '**/*Provider*.ts'],
        relatedDocs: ['docs/AI_PROVIDER_TYPES.md'],
        githubIssues: [1146],
      }),
      { now: AT, signal },
    );

    expect(fileName).toBe('never-read-api-keys-from-the-environment.md');
    expect(warnings).toEqual([]);

    const lines = contents.split('\n');
    expect(lines[0]).toBe('---');
    const close = lines.indexOf('---', 1);
    expect(close).toBeGreaterThan(1);
    expect(lines.slice(1, close)).toEqual([
      'globs:',
      '  - packages/runtime/src/ai/**/*.ts',
      '  - "**/*Provider*.ts"', // a plain scalar may not start with `*` in YAML
      'imports:',
      '  - docs/AI_PROVIDER_TYPES.md',
    ]);

    expect(lines[close + 2]).toBe('## Never Read API Keys From the Environment');
    expect(contents).toContain('### Why this rule exists');
    expect(contents).toContain('This rule exists because of GitHub #1146.');
    expect(contents).toContain(
      '*Promoted from Nimbalyst project memory on 2026-09-03 — recalled 14 times across 6 sessions and never contradicted.*',
    );
    expect(contents.endsWith('\n')).toBe(true);
    expect(contents.endsWith('\n\n')).toBe(false);
  });

  it('omits frontmatter for a rule that always applies', () => {
    const { contents } = renderRuleMarkdown(memory(), { now: AT });

    expect(contents.startsWith('## ')).toBe(true);
  });

  it('strips tracker keys and tells the reviewer which sentence lost its citation', () => {
    const { contents, warnings } = renderRuleMarkdown(
      memory({
        body: 'Mock the narrowest module, never the runtime barrel (see NIM-2374). It costs 2.6s per test file.',
        why: 'NIM-2374 measured the import cost.',
      }),
      { now: AT },
    );

    // The property that matters: a key scoped to one workspace's tracker room
    // never reaches a file that other checkouts will read.
    expect(contents).not.toMatch(/\bNIM-\d+\b/);
    expect(contents).toContain('never the runtime barrel. It costs 2.6s per test file.');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('NIM-2374');
    expect(warnings[0]).toContain('resolves to an unrelated item');
    // The quoted context is the sentence that lost its citation, as it now
    // reads — the reviewer is being asked to rewrite that one, not another.
    expect(warnings[0]).toContain('"Mock the narrowest module, never the runtime barrel."');
  });

  it('warns when the file would not say why the rule exists', () => {
    const { warnings } = renderRuleMarkdown(memory({ why: undefined }), { now: AT });

    expect(warnings.join(' ')).toContain('does not say why the rule exists');
  });

  it('refuses a memory with nothing to state', () => {
    expect(() => renderRuleMarkdown(memory({ body: '   ' }))).toThrow(/no body/);
    expect(() => ruleFileNameFor('!!!')).toThrow(/Cannot derive/);
  });
});

describe('tracker key handling', () => {
  it('leaves prose that merely looks like a key alone', () => {
    const text = 'Encode as UTF-8 and hash with SHA-256; the HTTP-2 path is unchanged.';

    expect(stripTrackerKeys(text).text).toBe(text);
  });

  it('is the last line of defence, not the first', () => {
    expect(() => assertNoTrackerKeys('See NIM-1 for context.')).toThrow(/NIM-1/);
    expect(() => assertNoTrackerKeys('See GitHub #1 for context.')).not.toThrow();
  });
});
