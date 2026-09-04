// @vitest-environment node
/**
 * Verdicts over realistic memory pages. The pairs below are the four
 * relationships the store has to tell apart — restatement, extension,
 * subset, and coincidental overlap — because collapsing any two of them
 * either loses a page or keeps a stale one.
 *
 * The last block is the honest part: it pins where a lexical-only measure
 * fails, and shows the semantic arm fixing exactly that case through the
 * existing signal struct rather than a new code path.
 */
import { describe, expect, it } from 'vitest';
import { compareProse, DEFAULT_DEDUP_POLICY, decideVerdict } from '../compare.js';
import { normalizeProse, profileText, tokenize } from '../normalize.js';

const BASE = `We moved the SQLite writes behind a WriteCoordinator because concurrent writers were hitting lock contention during tracker sync. The coordinator batches small writes into a single lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import. This was a day-one architectural component rather than an optimisation added later.`;

/** Same page, lightly edited: reordered clauses, a couple of word swaps. */
const NEAR_RESTATEMENT = `SQLite writes were moved behind a WriteCoordinator because concurrent writers hit lock contention during tracker sync. The coordinator batches small writes into one lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import. It was a day-one architectural component rather than an optimisation added later.`;

/** The same page plus genuinely new material. */
const SUPERSET = `${BASE}

A later measurement showed the batched lane cut p99 write latency from 340ms to 45ms on a six gigabyte database. We added a heartbeat so a stalled lane surfaces in the health view instead of silently backing up. The chunk size is 512 rows, tuned against the largest workspace we have on disk today.`;

/** One paragraph lifted out of the base page. */
const SUBSET = `The coordinator batches small writes into a single lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import.`;

/** Same subject, reworded, but reusing the domain nouns as an agent would. */
const MODERATE_PARAPHRASE = `Lock contention during tracker sync was the reason for the WriteCoordinator: concurrent writers were competing for the same SQLite lock. Bulk migrations now take a background lane so interactive queries do not wait.`;

/** Same claim, almost no shared vocabulary. */
const HEAVY_REWORD = `Bulk jobs and short reads used to fight over one database handle. Putting a serialising layer in front of the engine, with separate paths for big and small work, ended that.`;

const UNRELATED = `Frameless windows need explicit drag regions, and every interactive control inside one needs no-drag or it stops responding. Persisted bounds must be clamped against the current display arrangement at creation time, not after the window is shown.`;

describe('decideVerdict over realistic pages', () => {
  const cases: Array<{ name: string; next: string; existing: string; verdict: string }> = [
    { name: 'a lightly edited restatement', next: NEAR_RESTATEMENT, existing: BASE, verdict: 'duplicate' },
    { name: 'a page identical to the stored one', next: BASE, existing: BASE, verdict: 'duplicate' },
    { name: 'a page that extends the stored one', next: SUPERSET, existing: BASE, verdict: 'supersedes' },
    { name: 'a page contained by the stored one', next: SUBSET, existing: BASE, verdict: 'subsumed' },
    { name: 'a reworded page reusing domain nouns', next: MODERATE_PARAPHRASE, existing: BASE, verdict: 'related' },
    { name: 'a page about something else', next: UNRELATED, existing: BASE, verdict: 'distinct' },
  ];

  it.each(cases)('calls $name $verdict', ({ next, existing, verdict }) => {
    expect(compareProse(next, existing).verdict).toBe(verdict);
  });

  it('does not mistake an extension for a repeat even though they overlap heavily', () => {
    const result = compareProse(SUPERSET, BASE);

    // The overlap alone clears both duplicate thresholds; only the length guard
    // and the check order keep the new material from being discarded.
    expect(result.signals.containmentExistingInNew).toBeGreaterThan(0.9);
    expect(result.signals.lengthRatio).toBeGreaterThan(DEFAULT_DEDUP_POLICY.supersedeLengthRatio);
    expect(result.verdict).toBe('supersedes');
  });

  it('distinguishes supersede from subsume by direction, not by score', () => {
    const forward = compareProse(SUPERSET, BASE);
    const reverse = compareProse(BASE, SUPERSET);

    expect(forward.verdict).toBe('supersedes');
    expect(reverse.verdict).toBe('subsumed');
    expect(forward.signals.containmentExistingInNew).toBeCloseTo(
      reverse.signals.containmentNewInExisting,
      5
    );
  });

  it('treats two empty pages as duplicates and an empty page as unrelated', () => {
    expect(compareProse('', '').verdict).toBe('duplicate');
    expect(compareProse('', BASE).verdict).toBe('distinct');
  });
});

describe('the lexical ceiling, and the semantic arm that lifts it', () => {
  it('misses a heavy reword — the known limit of a keyless install', () => {
    const result = compareProse(HEAVY_REWORD, BASE);

    // Documented, not aspirational: with almost no shared vocabulary there is
    // nothing for a lexical measure to see. This pair needs an embedder.
    expect(result.verdict).toBe('distinct');
    expect(result.signals.tokenJaccard).toBeLessThan(DEFAULT_DEDUP_POLICY.relatedThreshold);
  });

  it('promotes that same pair once an embedder supplies a cosine', () => {
    const result = compareProse(HEAVY_REWORD, BASE, { semantic: 0.93 });

    expect(result.verdict).toBe('duplicate');
    expect(result.signals.semantic).toBe(0.93);
  });

  it('lets a caller retune thresholds without touching the measurement', () => {
    const strict = compareProse(NEAR_RESTATEMENT, BASE, {
      policy: { ...DEFAULT_DEDUP_POLICY, duplicateTokenJaccard: 0.99, duplicateShingleJaccard: 0.99 },
    });

    expect(strict.verdict).toBe('related');
    expect(compareProse(NEAR_RESTATEMENT, BASE).verdict).toBe('duplicate');
  });

  it('is a pure function of the signals', () => {
    const signals = {
      tokenJaccard: 0.1,
      shingleJaccard: 0.05,
      containmentNewInExisting: 0.2,
      containmentExistingInNew: 1,
      lengthRatio: 5,
    };
    expect(decideVerdict(signals).verdict).toBe('supersedes');
  });
});

describe('normalisation', () => {
  it('drops markdown syntax and link targets but keeps link text and code', () => {
    const normalized = normalizeProse(
      '## Heading\n- see [the migration doc](https://example.com/a/b) and `WriteCoordinator`\n'
    );

    expect(normalized).toContain('the migration doc');
    expect(normalized).toContain('writecoordinator');
    expect(normalized).not.toContain('example');
    expect(normalized).not.toContain('#');
  });

  it('folds inflections so the same claim measures as the same claim', () => {
    expect(tokenize('migrations were chunked')).toEqual(tokenize('migration was chunk'));
  });

  it('keeps a page and its markdown-wrapped form equivalent', () => {
    const plain = 'The coordinator batches small writes into a single lane.';
    const markdown = '### Notes\n\n- The **coordinator** batches small writes into a `single` lane.\n';

    expect(compareProse(plain, markdown).verdict).toBe('duplicate');
  });

  it('measures length over distinct vocabulary, so padding does not look like new content', () => {
    const padded = `${BASE} ${BASE}`;
    expect(profileText(padded).size).toBe(profileText(BASE).size);
    expect(compareProse(padded, BASE).verdict).toBe('duplicate');
  });
});
