import { describe, it, expect } from 'vitest';
import { buildReviewThreadsQuery } from '../GhApiService';

describe('buildReviewThreadsQuery', () => {
  it('interpolates the page size into both first: selections', () => {
    const query = buildReviewThreadsQuery(100);
    expect(query).toContain('reviewThreads(first:100)');
    expect(query).toContain('comments(first:100)');
  });

  it('never emits the literal interpolation placeholder', () => {
    // Regression guard: the query was once built from single-quoted strings,
    // so `${API_PAGE_SIZE}` was sent verbatim and GitHub's GraphQL parser
    // rejected it.
    const query = buildReviewThreadsQuery();
    expect(query).not.toContain('${');
    expect(query).not.toContain('API_PAGE_SIZE');
  });

  it('honors a custom page size', () => {
    const query = buildReviewThreadsQuery(25);
    expect(query).toContain('reviewThreads(first:25)');
    expect(query).toContain('comments(first:25)');
  });
});
