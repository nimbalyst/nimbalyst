import { describe, it, expect } from 'vitest';
import { updateInlineTrackerItem } from '../frontmatterUtils';

// Pins the inline write-back contract surfaced while investigating GitHub #404:
//  1. A due-date edit must land under the marker key the re-scan parser reads
//     (`due`), not the UI field name (`dueDate`), or the value is dropped on
//     the next scan.
//  2. An inline marker with no explicit `id:` must still be locatable for
//     write-back via a (line + title) fallback, otherwise editing it in the UI
//     fails silently.

describe('updateInlineTrackerItem', () => {
  it('writes a due-date edit under the `due` marker key, not `dueDate`', () => {
    const content = 'Fix the login bug #bug[id:bug_aaa status:to-do]';
    const result = updateInlineTrackerItem(content, 'bug_aaa', { dueDate: '2026-06-10' });
    expect(result).not.toBeNull();
    expect(result).toContain('due:2026-06-10');
    expect(result).not.toContain('dueDate:');
  });

  it('still round-trips the supported keys verbatim', () => {
    const content = 'Fix the login bug #bug[id:bug_aaa status:to-do priority:low]';
    const result = updateInlineTrackerItem(content, 'bug_aaa', { status: 'in-progress', priority: 'high' });
    expect(result).toContain('status:in-progress');
    expect(result).toContain('priority:high');
  });

  it('returns null for an id-less marker when no fallback locator is given', () => {
    const content = 'Fix the login bug #bug[status:to-do]';
    expect(updateInlineTrackerItem(content, 'bug_deterministic', { status: 'in-progress' })).toBeNull();
  });

  it('locates an id-less marker via the line+title fallback', () => {
    const content = 'Fix the login bug #bug[status:to-do]';
    const result = updateInlineTrackerItem(
      content,
      'bug_deterministic',
      { status: 'in-progress' },
      { lineNumber: 1, title: 'Fix the login bug' },
    );
    expect(result).not.toBeNull();
    expect(result).toContain('status:in-progress');
  });

  it('locates an id-less marker on a later line via the line+title fallback', () => {
    const content = 'intro line\nFix the login bug #bug[status:to-do]';
    const result = updateInlineTrackerItem(
      content,
      'bug_deterministic',
      { status: 'in-progress' },
      { lineNumber: 2, title: 'Fix the login bug' },
    );
    expect(result).toContain('status:in-progress');
  });

  it('does not edit a different id-less marker when neither line nor title agree', () => {
    const content = 'Fix the login bug #bug[status:to-do]\nUnrelated task #task[status:to-do]';
    const result = updateInlineTrackerItem(
      content,
      'bug_deterministic',
      { status: 'in-progress' },
      { lineNumber: 99, title: 'something else entirely' },
    );
    expect(result).toBeNull();
  });

  it('does not edit an id-less marker of a different type even if line and title agree', () => {
    const content = 'Fix the login bug #task[status:to-do]';
    const result = updateInlineTrackerItem(
      content,
      'bug_deterministic',
      { status: 'in-progress' },
      { lineNumber: 1, title: 'Fix the login bug' },
    );
    expect(result).toBeNull();
  });

  it('requires both line and title for an id-less marker (line alone does not match)', () => {
    const content = 'Fix the login bug #bug[status:to-do]';
    const result = updateInlineTrackerItem(
      content,
      'bug_deterministic',
      { status: 'in-progress' },
      { lineNumber: 1 },
    );
    expect(result).toBeNull();
  });

  it('does not write description into the marker', () => {
    const content = 'Fix the login bug #bug[id:bug_aaa status:to-do]';
    const result = updateInlineTrackerItem(content, 'bug_aaa', { description: 'a longer note' });
    expect(result).not.toBeNull();
    expect(result).not.toContain('description:');
    expect(result).not.toContain('a longer note');
  });

  it('replaces a previously mis-written dueDate: prop with the canonical due: key', () => {
    const content = 'Fix the login bug #bug[id:bug_aaa status:to-do dueDate:2026-01-01]';
    const result = updateInlineTrackerItem(content, 'bug_aaa', { dueDate: '2026-06-10' });
    expect(result).toContain('due:2026-06-10');
    expect(result).not.toContain('dueDate:');
  });
});
