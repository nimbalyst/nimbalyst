// @vitest-environment node
/**
 * The write path and the replica projection.
 *
 * The three things covered here are the ones that fail silently and expensively
 * if they regress: a page that redaction refused reaching storage anyway, a
 * volatile field reaching the committed replica, and the one-liner shape
 * becoming storable again. None of them are visible on screen, and the first
 * two are permanent once they happen — a credential in git history and a file
 * that conflicts on every branch are not fixed by a later commit.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DedupIndex } from '../../dedup/index.js';
import { toReplicaRecord, VOLATILE_FIELD_NAMES } from '../replica.js';
import { MEMORY_TRACKER_SCHEMA } from '../schema.js';
import { migrateVoiceMemory } from '../migrateVoiceMemory.js';
import { markSuperseded, writeMemoryPage } from '../write.js';
import { MEMORY_PAGE_MIN_CHARS, type MemoryRecord } from '../types.js';

/** A realistic page: prose that carries the context it needs to be read. */
const PAGE = `We route SQLite writes through a WriteCoordinator because concurrent writers were hitting lock contention during tracker sync. The coordinator batches small writes onto one lane and chunks large migrations onto a background lane, so an interactive query is never queued behind a bulk import. This was a day-one architectural component, not an optimisation bolted on afterwards.`;

const EXTENDED = `${PAGE}

A later measurement put the batched lane at 45ms p99 against 340ms before, on a six gigabyte database. We added a heartbeat so a stalled lane surfaces in the health view instead of backing up silently.`;

function stored(outcome: ReturnType<typeof writeMemoryPage>): MemoryRecord {
  if (outcome.status !== 'stored' && outcome.status !== 'review') {
    throw new Error(`expected a record, got ${outcome.status}`);
  }
  return outcome.record;
}

describe('the write path refuses what redaction blocks', () => {
  it('does not produce a record for a page carrying private key material', () => {
    const outcome = writeMemoryPage({
      body: `${PAGE}\n\nThe deploy key is below.\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy\n-----END RSA PRIVATE KEY-----`,
      type: 'convention',
      provenance: { kind: 'user' },
    });

    expect(outcome.status).toBe('blocked');
    // The whole point is that there is no record to persist: a caller that
    // reads `.record` off a blocked outcome does not compile.
    expect(outcome).not.toHaveProperty('record');
    if (outcome.status === 'blocked') {
      expect(outcome.blocks.map((b) => b.rule)).toContain('private-key-material');
    }
  });

  it('stores the redacted text, not the original, and flags that it did', () => {
    const secret = 'sk-Xk92Lm4Qw8Tz1Rb7Yv3Np6Hd5Fj0Gs2Ac4Ue8Wi1Ko3Mq7Zr';
    const outcome = writeMemoryPage({
      body: `${PAGE}\n\nThe indexer authenticated with ${secret} during that run.`,
      type: 'fact',
      provenance: { kind: 'user' },
    });

    const record = stored(outcome);
    expect(record.body).not.toContain(secret);
    expect(record.redacted).toBe(true);
    // A silent redaction is indistinguishable from a miss, so the finding has
    // to survive to the caller.
    expect(outcome.redactions.map((r) => r.kind)).toContain('openai-api-key');
  });
});

describe('the durable unit is a page', () => {
  it('rejects the one-liner shape v1 produced, above its 300-character cap', () => {
    const oneLiner =
      'Nimbalyst routes SQLite writes through a WriteCoordinator to avoid lock contention.';
    const outcome = writeMemoryPage({
      body: oneLiner,
      type: 'fact',
      provenance: { kind: 'distilled', sessionId: 's1' },
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.problems).toContain('too-short');
      expect(outcome.problems).toContain('single-sentence');
    }
    // The floor sits above the old candidate cap by construction, so nothing
    // that pipeline could emit is storable. If this ever inverts, the shape
    // gate has stopped meaning anything.
    expect(MEMORY_PAGE_MIN_CHARS).toBeGreaterThan(300);
  });

  it('accepts a page and derives a title from its first line', () => {
    const outcome = writeMemoryPage({
      body: `## Write coordination\n\n${PAGE}`,
      type: 'decision',
      scope: 'project',
      provenance: { kind: 'user', sessionId: 'sess-1' },
    });

    const record = stored(outcome);
    expect(outcome.status).toBe('stored');
    expect(record.title).toBe('Write coordination');
    expect(record.status).toBe('active');
    expect(record.validTo).toBeNull();
  });
});

describe('dedup outcomes stay distinct', () => {
  it('discards a restatement but supersedes an extension, keeping the link', () => {
    const index = new DedupIndex();
    const first = stored(
      writeMemoryPage({ body: PAGE, type: 'fact', provenance: { kind: 'user' } })
    );
    index.add(first.factId, first.body);

    const restated = writeMemoryPage(
      { body: PAGE, type: 'fact', provenance: { kind: 'user' } },
      { dedup: index }
    );
    expect(restated.status).toBe('discarded');

    const extended = writeMemoryPage(
      { body: EXTENDED, type: 'fact', provenance: { kind: 'user' } },
      { dedup: index }
    );
    expect(extended.status).toBe('stored');
    if (extended.status === 'stored') {
      // Collapsing supersede into discard is what makes a history view
      // impossible later: the extension would be thrown away and the link that
      // records "this replaced that" would never exist.
      expect(extended.supersedes).toContain(first.factId);
    }
  });

  it('narrows the superseded page\'s window to when the new claim started, not to now', () => {
    const older = stored(
      writeMemoryPage({
        body: PAGE,
        type: 'fact',
        provenance: { kind: 'user' },
        now: new Date('2026-01-01T00:00:00.000Z'),
      })
    );
    const newer = stored(
      writeMemoryPage({
        body: EXTENDED,
        type: 'fact',
        provenance: { kind: 'user' },
        validFrom: '2026-06-01T00:00:00.000Z',
        now: new Date('2026-08-30T00:00:00.000Z'),
      })
    );

    const retired = markSuperseded(older, newer);
    expect(retired.validTo).toBe(newer.validFrom);
    expect(retired.status).toBe('superseded');
    // Set once. A second supersede must not rewrite when the claim stopped
    // holding, or the timeline drifts every time the record is touched.
    expect(markSuperseded(retired, newer).validTo).toBe(newer.validFrom);
  });
});

describe('the replica projection', () => {
  it('cannot carry a volatile field, whatever the record holds', () => {
    const record = stored(
      writeMemoryPage({ body: PAGE, type: 'fact', provenance: { kind: 'user' } })
    );
    const hot: MemoryRecord = {
      ...record,
      recallCount: 47,
      lastRecalledAt: '2026-09-03T00:00:00.000Z',
    };

    const projected = toReplicaRecord(hot);

    // These change on every search. In a committed file they would rewrite it
    // constantly and conflict on every branch, which is the whole reason the
    // append-only merge profile holds.
    const keys = Object.keys(projected);
    for (const name of VOLATILE_FIELD_NAMES) {
      expect(keys).not.toContain(name);
    }
    expect(projected.factId).toBe(record.factId);
    expect(projected.body).toBe(record.body);
  });

  it('serialises with a stable key order so the file diffs cleanly', () => {
    const record = stored(
      writeMemoryPage({ body: PAGE, type: 'fact', provenance: { kind: 'user' } })
    );
    const once = JSON.stringify(toReplicaRecord(record));
    // Same record, different in-memory key insertion order.
    const shuffled = Object.fromEntries(
      Object.entries(record).reverse()
    ) as unknown as MemoryRecord;
    expect(JSON.stringify(toReplicaRecord(shuffled))).toBe(once);
  });
});

describe('the schema artifact', () => {
  it('matches the source object, so the file the user applies is never stale', async () => {
    const artifact = await readFile(
      path.join(__dirname, '../../../../memory-tracker-type.json'),
      'utf8'
    );
    expect(JSON.parse(artifact)).toEqual(JSON.parse(JSON.stringify(MEMORY_TRACKER_SCHEMA)));
  });
});

describe('voice-memory migration', () => {
  it('reads without writing, and reports one-liners rather than importing them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-migrate-'));
    const factsDir = 'voice-memory';
    await mkdir(path.join(root, factsDir), { recursive: true });

    const thin = path.join(root, factsDir, 'thin.md');
    await writeFile(
      thin,
      '---\npriority: 0\ncreated: "2026-06-29T13:13:36.098Z"\n---\n\nThe document KEY_ENVELOPE_DESIGN_ANALYSIS.md is out of date.\n'
    );
    await writeFile(
      path.join(root, factsDir, 'page.md'),
      `---\ncategory: decision\ncreated: "2026-05-02T10:00:00.000Z"\n---\n\n${PAGE}\n`
    );

    const result = await migrateVoiceMemory(root, factsDir);

    expect(result.scanned).toBe(2);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].type).toBe('decision');
    expect(result.records[0].provenance).toMatchObject({ kind: 'imported' });
    // `validFrom` is when the claim was made, taken from frontmatter, not the
    // instant the migration happened to run.
    expect(result.records[0].validFrom).toBe('2026-05-02T10:00:00.000Z');

    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: 'page-too-thin' }),
    ]);
    // The skipped fact keeps its text so it can be expanded by hand, and the
    // source file is still on disk — a migration that reads and writes
    // elsewhere is recoverable; one that moves is not.
    expect(result.skipped[0].text).toContain('KEY_ENVELOPE_DESIGN_ANALYSIS');
    await expect(readFile(thin, 'utf8')).resolves.toContain('KEY_ENVELOPE');
  });
});
