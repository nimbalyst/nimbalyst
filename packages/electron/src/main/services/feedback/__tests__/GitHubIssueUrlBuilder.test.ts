import { describe, it, expect } from 'vitest';
import { buildIssueUrl, FEEDBACK_REPO } from '../GitHubIssueUrlBuilder';

describe('GitHubIssueUrlBuilder', () => {
  it('builds a bug-report URL targeting the bug issue form', () => {
    const r = buildIssueUrl({ kind: 'bug', title: 'Crash on save', body: 'Steps...' });
    expect(r.ok).toBe(true);
    expect(r.url).toContain(`github.com/${FEEDBACK_REPO}/issues/new`);
    expect(r.url).toContain('template=bug_report.yml');
    expect(r.url).toContain('title=Crash+on+save');
    expect(r.url).toContain('problem=Steps...');
    // Labels/type come from the .yml template frontmatter -- never via query.
    expect(r.url).not.toContain('labels=');
    expect(r.url).not.toContain('body=');
  });

  it('builds a feature-request URL targeting the feature issue form', () => {
    const r = buildIssueUrl({ kind: 'feature', title: 'Add multi-cursor', body: 'Why...' });
    expect(r.ok).toBe(true);
    expect(r.url).toContain('template=feature_request.yml');
    expect(r.url).toContain('request=Why...');
    expect(r.url).not.toContain('labels=');
    expect(r.url).not.toContain('body=');
  });

  it('returns ok=false with a title-only fallback URL when the body is too long', () => {
    const longBody = 'x'.repeat(7000);
    const r = buildIssueUrl({ kind: 'bug', title: 'Big report', body: longBody });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-long');
    expect(r.url).toContain('title=Big+report');
    expect(r.url).not.toContain('problem=');
    expect(r.url.length).toBeLessThan(7000);
  });

  it('keeps URL-safe encoding intact', () => {
    const r = buildIssueUrl({
      kind: 'bug',
      title: 'Issue with paths & ?query',
      body: 'Body has\nnewlines',
    });
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/title=Issue\+with\+paths\+%26\+%3Fquery/);
    expect(r.url).toMatch(/problem=Body\+has%0Anewlines/);
  });
});
