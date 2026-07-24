import { describe, it, expect } from 'vitest';
import { buildGroundingNote, BRAINSTORM_CHOREOGRAPHY } from '../groundingNote';

describe('buildGroundingNote', () => {
  it('always includes the brainstorm choreography note', () => {
    const note = buildGroundingNote({});
    expect(note).toContain(BRAINSTORM_CHOREOGRAPHY);
  });

  it('reports a ready index with its chunk count', () => {
    const note = buildGroundingNote({
      status: { ready: true, chunks: 13759, denseChunks: 13759, indexing: false, lastEmbedError: null },
    });
    expect(note).toMatch(/13759 chunk/);
    expect(note).toMatch(/ready/i);
  });

  it('signals when the index is still building', () => {
    const note = buildGroundingNote({
      status: { ready: true, chunks: 120, indexing: true, lastEmbedError: null },
    });
    expect(note).toMatch(/still building|indexing/i);
    expect(note).toContain('120');
  });

  it('warns when semantic search is degraded by an embed error', () => {
    const note = buildGroundingNote({
      status: { ready: true, chunks: 100, indexing: false, lastEmbedError: 'fetch failed' },
    });
    expect(note).toMatch(/degraded|keyword/i);
  });

  it('reports a not-ready index (missing key) without throwing', () => {
    const note = buildGroundingNote({
      status: { ready: false, error: 'OpenAI API key not configured.' },
    });
    expect(note).toMatch(/not ready|not configured|key/i);
  });

  it('lists durable facts when present, capped to 8', () => {
    const facts = Array.from({ length: 10 }, (_, i) => ({ text: `fact number ${i}` }));
    const note = buildGroundingNote({
      status: { ready: true, chunks: 10, indexing: false, lastEmbedError: null },
      facts,
    });
    expect(note).toContain('fact number 0');
    expect(note).toContain('fact number 7');
    expect(note).not.toContain('fact number 8');
  });

  it('omits the facts section when there are no facts', () => {
    const note = buildGroundingNote({
      status: { ready: true, chunks: 10, indexing: false, lastEmbedError: null },
      facts: [],
    });
    expect(note).not.toMatch(/durable facts to keep in mind/i);
  });

  it('falls back to just the choreography when status is unavailable', () => {
    const note = buildGroundingNote({ status: null });
    expect(note).toContain(BRAINSTORM_CHOREOGRAPHY);
    expect(note).not.toMatch(/index ready/i);
  });
});
