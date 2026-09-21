// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  detectTrackerFromFrontmatter,
  extractFrontmatter,
  setShareInFrontmatter,
  setTrackerIdInFrontmatter,
  updateFrontmatter,
  updateTrackerInFrontmatter,
} from '../frontmatterUtils';

// A tracker edit rewrote the whole YAML header: comments were dropped, quoted
// scalars came back in a different style, and unquoted dates were expanded to
// ISO timestamps, so a one-field change produced a large git diff (GitHub
// #1552). These tests assert on exact bytes -- the point of the fix is the
// bytes, not the parsed values.

const HANDWRITTEN = [
  '---',
  "# Statuses come from the team's board",
  'title: "Rebuild the release gate"',
  'status: draft # bumped by hand during triage',
  'owner: "a.contributor"',
  'blocked: "yes"',
  'summary: "gate: blocks the release"',
  'tags:',
  '  - "release"',
  '  - infra',
  'created: 2026-09-19',
  'updated: 2026-09-19',
  'trackerStatus:',
  '  type: plan',
  '---',
  '',
  '# Rebuild the release gate',
  '',
  'Body text that has a --- rule inside it.',
  '',
].join('\n');

/** The fixture with one header line swapped, so expectations stay readable. */
function withLine(source: string, from: string, to: string | null): string {
  const lines = source.split('\n');
  const idx = lines.indexOf(from);
  expect(idx, `fixture line not found: ${from}`).toBeGreaterThanOrEqual(0);
  if (to === null) lines.splice(idx, 1);
  else lines[idx] = to;
  return lines.join('\n');
}

/** Insert lines immediately before the closing header delimiter. */
function appendToHeader(source: string, ...added: string[]): string {
  const lines = source.split('\n');
  const idx = lines.indexOf('---', 1);
  lines.splice(idx, 0, ...added);
  return lines.join('\n');
}

/** js-yaml resolves a bare `2026-09-19` node to UTC midnight; read it back as written. */
function expectDay(value: unknown, day: string): void {
  expect(value instanceof Date ? value.toISOString().slice(0, 10) : value).toBe(day);
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 19, 10, 30, 0)); // local 2026-09-19
});
afterAll(() => {
  vi.useRealTimers();
});

describe('frontmatter writers preserve untouched source (#1552)', () => {
  it('the fixture is a live tracker document, not a hypothetical one', () => {
    const detected = detectTrackerFromFrontmatter(HANDWRITTEN);
    expect(detected?.type).toBe('plan');
    expect(detected?.data.status).toBe('draft');
    expect(detected?.data.blocked).toBe('yes');
  });

  it('a one-field tracker edit changes only that field, keeping both comments', () => {
    const updated = updateTrackerInFrontmatter(HANDWRITTEN, 'plan', { status: 'completed' });

    expect(updated).toBe(
      withLine(
        HANDWRITTEN,
        'status: draft # bumped by hand during triage',
        'status: completed # bumped by hand during triage',
      ),
    );
  });

  it('keeps the edited key\'s quoting style and leaves other scalars alone', () => {
    const updated = updateFrontmatter(HANDWRITTEN, { owner: 'b.maintainer' });
    expect(updated).toBe(
      withLine(HANDWRITTEN, 'owner: "a.contributor"', 'owner: "b.maintainer"'),
    );
  });

  it('rewrites a block sequence in place without touching neighbours', () => {
    const updated = updateFrontmatter(HANDWRITTEN, { tags: ['infra'] });
    expect(updated).toBe(
      HANDWRITTEN.replace('tags:\n  - "release"\n  - infra\n', 'tags:\n  - infra\n'),
    );
    expect(extractFrontmatter(updated)?.tags).toEqual(['infra']);
  });

  it('appends new keys rather than reordering the header', () => {
    const updated = updateFrontmatter(HANDWRITTEN, { priority: 'high' });
    expect(updated).toBe(appendToHeader(HANDWRITTEN, 'priority: high'));
  });

  it('keeps null-writes-a-null / undefined-deletes semantics', () => {
    expect(updateFrontmatter(HANDWRITTEN, { owner: null })).toBe(
      withLine(HANDWRITTEN, 'owner: "a.contributor"', 'owner: null'),
    );
    expect(updateFrontmatter(HANDWRITTEN, { owner: undefined })).toBe(
      withLine(HANDWRITTEN, 'owner: "a.contributor"', null),
    );
  });

  it('round-trips share set then clear back to the original bytes', () => {
    const shared = setShareInFrontmatter(HANDWRITTEN, { status: 'shared', body: 'team-abc' });
    expect(shared).toBe(
      appendToHeader(HANDWRITTEN, 'share:', '  status: shared', '  body: team-abc'),
    );
    expect(setShareInFrontmatter(shared, null)).toBe(HANDWRITTEN);
  });

  it('round-trips trackerId set then clear back to the original bytes', () => {
    const withId = setTrackerIdInFrontmatter(HANDWRITTEN, 'tr_abc123');
    expect(withId).toBe(appendToHeader(HANDWRITTEN, 'trackerId: tr_abc123'));
    expect(setTrackerIdInFrontmatter(withId, null)).toBe(HANDWRITTEN);
  });

  it('preserves CRLF line endings on a Windows checkout', () => {
    const crlf = HANDWRITTEN.replace(/\n/g, '\r\n');
    const updated = updateTrackerInFrontmatter(crlf, 'plan', { status: 'completed' });
    expect(updated).toBe(
      crlf.replace(
        'status: draft # bumped by hand during triage',
        'status: completed # bumped by hand during triage',
      ),
    );
    expect(updated).not.toContain('\n\n'); // no bare LF introduced anywhere
  });

  it('adds a header to a file that has none', () => {
    expect(updateFrontmatter('# Title\n\nBody\n', { status: 'draft' })).toBe(
      '---\nstatus: draft\n---\n# Title\n\nBody\n',
    );
  });
});

describe('extension-owned and legacy headers (#1552)', () => {
  const AUTOMATION = [
    '---',
    'title: Stale Title',
    'status: active # set by hand',
    '# owned by the automations extension',
    'automationStatus:',
    '  id: daily-build',
    '  title: "Daily Build"',
    '  enabled: true',
    '  schedule: { type: daily,   time: "09:00" }',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  it('leaves the nested extension block byte-for-byte, odd flow spacing included', () => {
    const updated = updateTrackerInFrontmatter(AUTOMATION, 'automation', { status: 'paused' });

    expect(updated).toBe(
      [
        '---',
        'status: paused # set by hand',
        '# owned by the automations extension',
        'automationStatus:',
        '  id: daily-build',
        '  title: "Daily Build"',
        '  enabled: true',
        '  schedule: { type: daily,   time: "09:00" }',
        "created: '2026-09-19'",
        "updated: '2026-09-19'",
        'trackerStatus:',
        '  type: automation',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
  });

  it('still promotes legacy planStatus fields and keeps the rest of the file', () => {
    const legacy = [
      '---',
      '# hand-written legacy header',
      'planStatus:',
      '  status: "in-progress"',
      '  owner: alice',
      'title: Old plan',
      'created: 2026-01-02',
      '---',
      '',
      'Legacy body.',
      '',
    ].join('\n');

    const updated = updateTrackerInFrontmatter(legacy, 'plan', { status: 'completed' });
    const fm = extractFrontmatter(updated);

    expect(fm).not.toHaveProperty('planStatus');
    expect(fm?.status).toBe('completed');
    expect(fm?.owner).toBe('alice');
    expect(fm?.title).toBe('Old plan');
    expect(fm?.trackerStatus).toEqual({ type: 'plan' });
    expectDay(fm?.created, '2026-01-02');
    expectDay(fm?.updated, '2026-09-19');
    expect(updated).toContain('# hand-written legacy header');
    expect(updated).toContain('title: Old plan');
    expect(updated.endsWith('\n\nLegacy body.\n')).toBe(true);
  });
});

describe('YAML constructs a partial rewrite must not corrupt (#1552)', () => {
  const BLOCK_SCALAR = [
    '---',
    'title: "Release gate"',
    'notes: |',
    '  first line',
    '  second line',
    'status: draft',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  it('leaves a block scalar alone when another key is edited', () => {
    expect(updateFrontmatter(BLOCK_SCALAR, { status: 'completed' })).toBe(
      BLOCK_SCALAR.replace('status: draft', 'status: completed'),
    );
  });

  it('rewrites a block scalar in place and reads back the new text', () => {
    const updated = updateFrontmatter(BLOCK_SCALAR, { notes: 'only line\nand another' });
    expect(updated).toBe(
      [
        '---',
        'title: "Release gate"',
        'notes: |-',
        '  only line',
        '  and another',
        'status: draft',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    expect(extractFrontmatter(updated)?.notes).toBe('only line\nand another');
  });

  it('removes a block sequence without disturbing its neighbours', () => {
    const updated = updateFrontmatter(HANDWRITTEN, { tags: undefined });
    expect(updated).toBe(HANDWRITTEN.replace('tags:\n  - "release"\n  - infra\n', ''));
  });

  it('keeps a comment that sits between the key and its value', () => {
    const source = [
      '---',
      'tags: # the board reads these',
      '  - release',
      'status: draft',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');

    expect(updateFrontmatter(source, { tags: ['infra', 'release'] })).toBe(
      source.replace('  - release\n', '  - infra\n  - release\n'),
    );
  });

  it('writes into a comment-only or empty header instead of replacing it', () => {
    expect(updateFrontmatter('---\n# just a note\n---\nBody\n', { status: 'draft' })).toBe(
      '---\n# just a note\nstatus: draft\n---\nBody\n',
    );
    // An empty header is a header, not an unterminated one -- prepending a
    // second one would leave the file with two.
    expect(updateFrontmatter('---\n---\nBody\n', { status: 'draft' })).toBe(
      '---\nstatus: draft\n---\nBody\n',
    );
  });

  const ANCHORED = [
    '---',
    'defaults: &defaults',
    '  owner: alice',
    'config: *defaults',
    'status: draft',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  it('edits around untouched anchors, but refuses to rewrite an anchored or aliased key', () => {
    expect(updateFrontmatter(ANCHORED, { status: 'completed' })).toBe(
      ANCHORED.replace('status: draft', 'status: completed'),
    );
    expect(() => updateFrontmatter(ANCHORED, { defaults: { owner: 'bob' } })).toThrow(/anchor/i);
    expect(() => updateFrontmatter(ANCHORED, { config: { owner: 'bob' } })).toThrow(/anchor|alias/i);
    expect(() => updateFrontmatter(ANCHORED, { config: undefined })).toThrow(/anchor|alias/i);
  });

  it('rejects a flow mapping at the root and a duplicated key', () => {
    expect(() => updateFrontmatter('---\n{ a: 1, b: 2 }\n---\nBody\n', { a: 2 })).toThrow(/flow/i);
    expect(() =>
      updateFrontmatter('---\nstatus: draft\nstatus: done\n---\nBody\n', { owner: 'a' }),
    ).toThrow();
  });
});

describe('written values read back through the js-yaml reader (#1552)', () => {
  it('quotes a plain-styled key only when the reader would change its type', () => {
    const stillPlain = updateFrontmatter(HANDWRITTEN, { status: 'yes' });
    expect(stillPlain).toBe(withLine(HANDWRITTEN, 'status: draft # bumped by hand during triage', 'status: yes # bumped by hand during triage'));
    expect(extractFrontmatter(stillPlain)?.status).toBe('yes');

    const quoted = updateFrontmatter(HANDWRITTEN, { status: '2026-12-01' });
    expect(quoted).toBe(
      withLine(
        HANDWRITTEN,
        'status: draft # bumped by hand during triage',
        "status: '2026-12-01' # bumped by hand during triage",
      ),
    );
    expect(extractFrontmatter(quoted)?.status).toBe('2026-12-01');
  });

  it('honours an intentional Date-to-string or string-to-Date change on a date key', () => {
    // The tracker's own `updated` stamp skips a same-day node, but a caller
    // asking for a string gets a string the reader agrees is a string.
    const asString = updateFrontmatter(HANDWRITTEN, { created: '2026-09-19' });
    expect(asString).toBe(withLine(HANDWRITTEN, 'created: 2026-09-19', "created: '2026-09-19'"));
    expect(extractFrontmatter(asString)?.created).toBe('2026-09-19');

    const asDate = updateFrontmatter(HANDWRITTEN, { created: new Date(Date.UTC(2026, 8, 20)) });
    const readBack = extractFrontmatter(asDate)?.created;
    expect(readBack).toBeInstanceOf(Date);
    expect((readBack as Date).toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('appends a multi-line string as a block scalar the reader round-trips', () => {
    const updated = updateFrontmatter(HANDWRITTEN, { notes: 'one\ntwo' });
    expect(extractFrontmatter(updated)?.notes).toBe('one\ntwo');
    expect(updated).toContain('notes: |-\n  one\n  two\n');
  });
});

describe('tracker write policy survives the move to ops (#1552)', () => {
  const EXTENSION = [
    '---',
    'status: draft # set by hand',
    'automationStatus:',
    '  id: daily-build',
    '  enabled: true',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  const NO_CREATED = [
    '---',
    'status: draft',
    'trackerStatus:',
    '  type: plan',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  it('lets the stamped `updated` win over a caller-supplied one, without colliding', () => {
    // The old writer merged into one object, so the policy stamp simply
    // overwrote the caller's value. Two ops for one key must behave the same.
    const updated = updateTrackerInFrontmatter(HANDWRITTEN, 'plan', {
      status: 'completed',
      updated: '2026-09-02',
    });
    expect(updated).toBe(
      withLine(
        HANDWRITTEN,
        'status: draft # bumped by hand during triage',
        'status: completed # bumped by hand during triage',
      ),
    );

    // Same collision, but where both writes would land on the source: the file
    // carries an older `updated`, so neither op is a no-op.
    const stale = withLine(HANDWRITTEN, 'updated: 2026-09-19', 'updated: 2026-09-01');
    const restamped = updateTrackerInFrontmatter(stale, 'plan', { updated: '2026-09-02' });
    expectDay(extractFrontmatter(restamped)?.updated, '2026-09-19');
  });

  it('lets the tracker type win over a caller-supplied trackerStatus', () => {
    const updated = updateTrackerInFrontmatter(HANDWRITTEN, 'plan', {
      trackerStatus: { type: 'bug' },
    });
    expect(extractFrontmatter(updated)?.trackerStatus).toEqual({ type: 'plan' });
  });

  it('deletes a top-level field set to undefined on an extension-owned header', () => {
    const updated = updateTrackerInFrontmatter(EXTENSION, 'automation', { status: undefined });
    expect(extractFrontmatter(updated)).not.toHaveProperty('status');
    expect(updated).not.toContain('status: draft');
    expect(updated).toContain('  id: daily-build');
  });

  it('backfills `created` when the effective value is empty, on both header shapes', () => {
    // Old policy stamped `created` whenever the merged top-level value was
    // falsy -- including when the caller explicitly passed null or ''.
    for (const [label, source, type] of [
      ['canonical', NO_CREATED, 'plan'],
      ['extension-owned', EXTENSION, 'automation'],
    ] as const) {
      for (const empty of [null, '', undefined]) {
        const updated = updateTrackerInFrontmatter(source, type, { created: empty });
        expect(extractFrontmatter(updated)?.created, `${label} / ${String(empty)}`).toBe(
          '2026-09-19',
        );
      }
    }
  });

  it('keeps a caller-supplied `created` that is not empty', () => {
    const updated = updateTrackerInFrontmatter(NO_CREATED, 'plan', { created: '2025-01-05' });
    expect(extractFrontmatter(updated)?.created).toBe('2025-01-05');
  });
});

describe('frontmatter writers reject headers they cannot safely rewrite (#1552)', () => {
  const cases: Array<[string, string]> = [
    ['unterminated header', '---\ntitle: Only opener\n\nBody\n'],
    ['invalid YAML', '---\ntitle: [unclosed\n---\n\nBody\n'],
    ['non-map header', '---\n- one\n- two\n---\n\nBody\n'],
  ];

  for (const [label, content] of cases) {
    it(`throws rather than overwriting a ${label}`, () => {
      expect(() => updateFrontmatter(content, { status: 'draft' })).toThrow();
      expect(() => updateTrackerInFrontmatter(content, 'plan', { status: 'draft' })).toThrow();
      expect(() => setShareInFrontmatter(content, { status: 'shared', body: 'x' })).toThrow();
      expect(() => setTrackerIdInFrontmatter(content, 'tr_1')).toThrow();
    });
  }
});
