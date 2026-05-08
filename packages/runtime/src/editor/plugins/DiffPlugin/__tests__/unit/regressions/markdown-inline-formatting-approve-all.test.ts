import { describe, expect, it } from 'vitest';

import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  setupMarkdownReplaceTestWithFullReplacement,
} from '../../utils/replaceTestUtils';

describe('approve-all markdown inline formatting regressions', () => {
  it('preserves strong spans containing inline code and trailing plain parentheticals', () => {
    const originalMarkdown = '- placeholder\n- placeholder\n- placeholder';
    const targetMarkdown = [
      '- **Outer `code` outer**',
      '- **leading text** (#1)',
      '- **`@` mentions of `code` again.**',
    ].join('\n');

    const result = setupMarkdownReplaceTestWithFullReplacement(
      originalMarkdown,
      targetMarkdown,
    );

    expect(result.getApprovedMarkdown()).toBe(targetMarkdown);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  it('keeps trailing parentheticals plain when appended after a bold span', () => {
    const originalMarkdown = '- **leading text**';
    const targetMarkdown = '- **leading text** (#1)';

    const result = setupMarkdownReplaceTestWithFullReplacement(
      originalMarkdown,
      targetMarkdown,
    );

    expect(result.getApprovedMarkdown()).toBe(targetMarkdown);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
