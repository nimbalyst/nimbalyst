/**
 * Test for large document diff failure case
 * Files: test2-old.md vs test2-new.md
 *
 * This is a real-world example where the new document is significantly shorter (72 lines vs 202 lines)
 * The document was substantially rewritten and condensed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { largeDocumentDiff } from '../../utils/largeDocumentDiff';

describe('Larger document diff - test2 (PM guide rewrite)', () => {
  let fixture: ReturnType<typeof largeDocumentDiff>;
  beforeAll(() => { fixture = largeDocumentDiff('test2'); });

  it('correctly accepts the rewrite and rejects back to the original formatting and order', () => {
    const { result } = fixture;
    expect(result.success, result.errors.join('\n')).toBe(true);
    const totalChanged = result.withDiff.stats.addedNodes + result.withDiff.stats.removedNodes + result.withDiff.stats.modifiedNodes;
    expect(totalChanged).toBeGreaterThan(10);
    expect(result.afterAccept.markdown).toContain('Claude Code for Product Managers');
    expect(result.afterReject.markdown).toContain('Claude Code for Product Managers');
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('preserves the intended new document after accepting all changes', () => {
    const { result, newMarkdown } = fixture;
    expect(result.success, result.errors.join('\n')).toBe(true);
    expect(result.afterAccept.markdown).toContain('Claude Code for Product Managers');
    expect(result.afterAccept.markdown.length).toBeGreaterThan(newMarkdown.length * 0.9);
    expect(result.afterAccept.markdown.length).toBeLessThan(newMarkdown.length * 1.1);
  });
});
