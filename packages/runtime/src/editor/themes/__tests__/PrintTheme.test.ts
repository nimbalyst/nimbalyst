import { describe, expect, it } from 'vitest';
import { wrapWithPrintStyles } from '../PrintTheme';

describe('wrapWithPrintStyles', () => {
  it('includes an escaped title in the exported document', () => {
    const html = wrapWithPrintStyles('<h1>Heading</h1>', 'Plan & "Spec" <draft>.md');

    expect(html).toContain('<title>Plan &amp; &quot;Spec&quot; &lt;draft&gt;.md</title>');
  });

  it('keeps a fallback title when none is provided', () => {
    const html = wrapWithPrintStyles('<p>Content</p>');

    expect(html).toContain('<title>Document</title>');
  });
});
