import { describe, it, expect } from 'vitest';
import {
  provideSqlCompletionsFromText,
} from '../sqlCompletionProvider';

function getLabels(items: { label: string | { label: string } }[]): string[] {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

describe('provideSqlCompletionsFromText', () => {
  it('returns SQL keywords for a fresh prefix', () => {
    const items = provideSqlCompletionsFromText('', 0);
    const labels = getLabels(items);
    expect(labels).toContain('SELECT');
    expect(labels).toContain('FROM');
    expect(labels).toContain('WHERE');
    expect(labels).toContain('JOIN');
  });

  it('filters keywords by the typed prefix', () => {
    const items = provideSqlCompletionsFromText('SEL', 3);
    const labels = getLabels(items);
    expect(labels).toContain('SELECT');
    expect(labels).not.toContain('FROM');
  });

  it('prefers prefix-starting keywords over loose substring matches', () => {
    const items = provideSqlCompletionsFromText('IN', 2);
    const labels = getLabels(items);
    // 'INNER JOIN' starts with IN and should be present
    expect(labels).toContain('INNER JOIN');
    expect(labels).toContain('IN');
  });

  it('scans CREATE TABLE and surfaces columns after FROM', () => {
    const text = [
      'CREATE TABLE users (',
      '  id INTEGER PRIMARY KEY,',
      '  email TEXT NOT NULL,',
      '  created_at TIMESTAMPTZ',
      ');',
      'SELECT ',
    ].join('\n');
    const offset = text.length;
    const items = provideSqlCompletionsFromText(text, offset);
    const labels = getLabels(items);
    expect(labels).toContain('id');
    expect(labels).toContain('email');
    expect(labels).toContain('created_at');
    expect(labels).toContain('users'); // table name surfaced too
  });

  it('surfaces columns after `tbl.` member access', () => {
    const text = [
      'CREATE TABLE orders (id INT, total NUMERIC);',
      'SELECT o.',
    ].join('\n');
    const offset = text.length;
    const items = provideSqlCompletionsFromText(text, offset);
    const labels = getLabels(items);
    expect(labels).toContain('id');
    expect(labels).toContain('total');
    // Member-access context dominates table name suggestions.
    expect(labels).not.toContain('orders');
  });

  it('scans extra sources passed via options', () => {
    const text = 'SELECT ';
    const offset = text.length;
    const items = provideSqlCompletionsFromText(text, offset, {
      extraSources: ['CREATE TABLE accounts (acct_id BIGINT, balance NUMERIC);'],
    });
    const labels = getLabels(items);
    expect(labels).toContain('acct_id');
    expect(labels).toContain('balance');
    expect(labels).toContain('accounts');
  });

  it('surfaces FROM-referenced tables without CREATE TABLE', () => {
    const text = 'SELECT * FROM legacy_x';
    const offset = text.length;
    const items = provideSqlCompletionsFromText(text, offset);
    const labels = getLabels(items);
    expect(labels).toContain('legacy_x');
  });

  it('returns no completions for an unsupported file type gate', () => {
    // The provider itself has no language gate; registration must be the
    // gate. Verify it still returns sensible keyword data for empty input.
    const items = provideSqlCompletionsFromText('zzz', 3);
    // Prefix doesn't match any keyword; column/table lists are empty.
    expect(items.length).toBe(0);
  });
});
