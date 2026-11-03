// @vitest-environment node
/**
 * Colored text in transcript markdown: `<span style="color: ...">` renders as
 * a styled span, and nothing else in raw HTML gets through. react-markdown
 * prints any raw HTML the plugin leaves alone as literal text.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

import { rehypeTextColorSpans } from '../rehypeTextColorSpans';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeTextColorSpans] }, markdown));
}

/** Every rendered `<span ...>` start tag, attributes included. */
function spanTags(html: string): string[] {
  return html.match(/<span\b[^>]*>/g) ?? [];
}

describe('rehypeTextColorSpans', () => {
  it('renders a palette span around bold text as one styled span with only a style attribute', () => {
    const html = render('<span style="color: #f03e3e">**Blocked** on review</span> done');
    const tags = spanTags(html);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/^<span class="transcript-text-color" style="[^"]*">$/);
    expect(html).toContain('<strong>Blocked</strong> on review</span> done');
    expect(html).not.toContain('&lt;span');
  });

  it('keeps a non-palette color as written and supports both kinds plus nesting', () => {
    const html = render('<span style="background-color: rgb(1, 2, 3)">a <span style="color: teal">b</span></span>');
    const tags = spanTags(html);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('rgb(1, 2, 3)');
    expect(tags[1]).toContain('teal');
  });

  it.each([
    ['another style property', '<span style="color: red; position: fixed">x</span>'],
    ['another attribute', '<span onclick="alert(1)" style="color: red">x</span>'],
    ['a class', '<span class="evil" style="color: red">x</span>'],
    ['an unsafe value', '<span style="background-color: url(https://example.com/a.png)">x</span>'],
    ['another element', '<div style="color: red">x</div>'],
    ['an unclosed span', '<span style="color: red">x'],
  ])('leaves raw HTML with %s as literal text', (_label, markdown) => {
    const html = render(markdown);
    expect(spanTags(html)).toEqual([]);
    // No real element carries the disallowed parts; they only appear escaped.
    expect(html).not.toMatch(/<div[\s>]|<[^>]+onclick=|<[^>]+position:|<[^>]+url\(/i);
    expect(html).toContain('&lt;');
  });
});
