import { describe, it, expect } from 'vitest';
import { buildDistillMessages, parseDistillResponse } from '../distill';

describe('buildDistillMessages', () => {
  it('includes each doc path and caps the excerpt length', () => {
    const long = 'x'.repeat(10_000);
    const msgs = buildDistillMessages([{ path: 'plans/a.md', content: long }], 100);
    expect(msgs[0].role).toBe('system');
    const user = msgs[1].content;
    expect(user).toContain('plans/a.md');
    // excerpt capped well under the raw 10k
    expect(user.length).toBeLessThan(2000);
  });

  it('asks for JSON output in the system prompt', () => {
    const msgs = buildDistillMessages([{ path: 'p.md', content: 'hi' }]);
    expect(msgs[0].content.toLowerCase()).toContain('json');
  });
});

describe('parseDistillResponse', () => {
  it('parses a plain JSON array of objects', () => {
    const text = JSON.stringify([
      { text: 'Use better-sqlite3 with WAL', category: 'decision' },
      { text: 'No emojis in UI copy', category: 'preference', scope: 'ui' },
    ]);
    const out = parseDistillResponse(text, []);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: 'Use better-sqlite3 with WAL', category: 'decision', scope: null });
    expect(out[1]).toMatchObject({ scope: 'ui' });
  });

  it('tolerates code fences and a wrapping object', () => {
    const text = '```json\n{ "facts": ["Voice mode uses OpenAI Realtime"] }\n```';
    const out = parseDistillResponse(text, []);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Voice mode uses OpenAI Realtime');
    expect(out[0].category).toBeNull();
  });

  it('dedupes against existing facts (case/space-insensitive) and within the batch', () => {
    const text = JSON.stringify([
      { text: 'The DB is better-sqlite3' },
      { text: '  the db is better-sqlite3 ' },
      { text: 'A brand new fact' },
    ]);
    const out = parseDistillResponse(text, ['The DB is better-sqlite3']);
    expect(out.map((c) => c.text)).toEqual(['A brand new fact']);
  });

  it('drops empty and over-long candidates', () => {
    const text = JSON.stringify([
      { text: '' },
      { text: '   ' },
      { text: 'y'.repeat(400) },
      { text: 'keeper' },
    ]);
    const out = parseDistillResponse(text, []);
    expect(out.map((c) => c.text)).toEqual(['keeper']);
  });

  it('returns [] for unparseable model output without throwing', () => {
    expect(parseDistillResponse('I could not find any facts.', [])).toEqual([]);
  });
});
