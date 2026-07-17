import { describe, expect, it } from 'vitest';
import { deriveIssueKeyPrefix } from '../trackerIssueKeyPrefix';

describe('deriveIssueKeyPrefix', () => {
  it('uses the first three project-name letters', () => {
    expect(deriveIssueKeyPrefix('/Users/dev/stravu-editor')).toBe('STR');
    expect(deriveIssueKeyPrefix('Nimbalyst')).toBe('NIM');
  });

  it('ignores separators, punctuation, numbers, and accents', () => {
    expect(deriveIssueKeyPrefix('my-project')).toBe('MYP');
    expect(deriveIssueKeyPrefix('2026 Ångström')).toBe('ANG');
    expect(deriveIssueKeyPrefix('C:\\src\\road-party')).toBe('ROA');
  });

  it('keeps valid two-letter names and falls back for shorter names', () => {
    expect(deriveIssueKeyPrefix('/projects/AI')).toBe('AI');
    expect(deriveIssueKeyPrefix('/projects/x')).toBe('NIM');
    expect(deriveIssueKeyPrefix('123')).toBe('NIM');
  });
});
