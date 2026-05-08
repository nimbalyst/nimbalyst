/**
 * Regression: rejecting added listitems that come AFTER a kept
 * nested-list-wrapper used to leave stray content behind, because
 * @lexical/list's ListItemNode.remove() auto-merges its siblings when
 * BOTH neighbors are nested-list-wrappers (see `mergeLists` in
 * @lexical/list). Removing the added text-listitem in the middle of
 * "[kept-wrapper, added-text, added-wrapper]" merged the added-wrapper's
 * nested URL bullet INTO the kept wrapper before we got around to
 * removing the added-wrapper itself, leaving the merged-in bullet behind
 * after rejection.
 *
 * The fix in ListDiffHandler is to defer all removals to a reverse-order
 * pass so the rightmost added wrapper is removed first, by which point
 * its right neighbor is gone and the merge condition no longer fires.
 *
 * The realistic AI-edit shape (recovered from a real workspace edit):
 *   baseline: Texas + URL bullet, Deleware + URL: placeholder
 *   target:   ... + Delaware URL filled in + new California section
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';

describe('Reject added listitem-with-nested-list adjacent to kept wrapper', () => {
  it('does not leak the added wrapper\'s nested content into the kept wrapper on reject', () => {
    const baseline = `# Small

- Texas
  - **URL**: https://en.wikipedia.org/wiki/Texas
- Deleware
  - **URL:**
`;
    const target = `# Small

- Texas
  - **URL**: https://en.wikipedia.org/wiki/Texas
- Deleware
  - **URL:** https://en.wikipedia.org/wiki/Delaware
- California
  - **URL:** https://en.wikipedia.org/wiki/California
`;

    const result = testComprehensiveDiff(baseline, target);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
