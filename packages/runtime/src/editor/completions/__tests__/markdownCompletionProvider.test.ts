import { describe, it, expect } from 'vitest';
import { provideMarkdownCompletionsFromText } from '../markdownCompletionProvider';

function getLabels(items: { label: string | { label: string } }[]): string[] {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

describe('provideMarkdownCompletionsFromText', () => {
  it('returns snippet items for an empty prefix', () => {
    const items = provideMarkdownCompletionsFromText('', 0);
    const labels = getLabels(items);
    expect(labels).toContain('# Heading 1');
    expect(labels).toContain('## Heading 2');
    expect(labels).toContain('### Heading 3');
    expect(labels).toContain('link');
    expect(labels).toContain('```code```');
    expect(labels).toContain('```python```');
  });

  it('filters by prefix', () => {
    const items = provideMarkdownCompletionsFromText('li', 2);
    const labels = getLabels(items);
    expect(labels).toContain('link');
    expect(labels).not.toContain('image');
    expect(labels).not.toContain('# Heading 1');
  });

  it('keeps heading snippets when prefix is `#`', () => {
    const items = provideMarkdownCompletionsFromText('#', 1);
    const labels = getLabels(items);
    expect(labels).toContain('# Heading 1');
    expect(labels).toContain('## Heading 2');
  });

  it('marks items as snippets with tab-stop insertText', () => {
    const items = provideMarkdownCompletionsFromText('link', 4);
    const linkItem = items.find((i) => i.label === 'link');
    expect(linkItem).toBeDefined();
    expect((linkItem as { insertText: string }).insertText).toBe('[${1:text}](${2:url})');
    expect((linkItem as { insertTextRules?: number }).insertTextRules).toBe(4);
  });

  it('language-gates: returns nothing when prefix matches none of the snippets', () => {
    const items = provideMarkdownCompletionsFromText('zzzzz', 5);
    expect(items).toEqual([]);
  });

  it('exposes fenced code blocks for popular languages', () => {
    const items = provideMarkdownCompletionsFromText('', 0);
    const labels = getLabels(items);
    expect(labels).toContain('```python```');
    expect(labels).toContain('```typescript```');
    expect(labels).toContain('```bash```');
    expect(labels).toContain('```json```');
  });
});
