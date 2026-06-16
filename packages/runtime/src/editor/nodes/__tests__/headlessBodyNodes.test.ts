import { describe, it, expect } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot } from 'lexical';

import HeadlessBodyNodes from '../headlessBodyNodes';
// Side-effect: populate the transformer set (core + built-in extensions) so
// getEditorTransformers() returns the same list MainBodyDocService uses.
import '../../extensions/registerBuiltinExtensions';
import { getEditorTransformers } from '../../markdown';
import { $convertFromEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownImport';

// A representative GitHub issue body: bullet + ordered lists, a link, inline
// and fenced code, a heading, and a horizontal rule -- the exact shapes that
// previously threw "Node list is not registered" and left the body empty.
const GITHUB_MARKDOWN = `### Describe the bug

The thing breaks. Steps:

- first
- second
  - nested

1. one
2. two

See [the docs](https://example.com/docs) and \`inlineCode\`.

\`\`\`ts
const x = 1;
\`\`\`

---

Done.`;

describe('HeadlessBodyNodes', () => {
  it('converts list/link/code/hr markdown without an unregistered-node error', () => {
    const errors: Error[] = [];
    const editor = createHeadlessEditor({
      namespace: 'headless-body-test',
      nodes: [...HeadlessBodyNodes],
      onError: (err: Error) => errors.push(err),
    });

    editor.update(
      () => {
        $convertFromEnhancedMarkdownString(GITHUB_MARKDOWN, getEditorTransformers(), undefined, true, false);
      },
      { discrete: true }
    );

    // No "Node <type> is not registered" errors leaked during conversion.
    const notRegistered = errors.filter((e) => /not registered/i.test(e.message));
    expect(notRegistered).toEqual([]);

    // And the body actually parsed into multiple block nodes (not empty).
    let childCount = 0;
    let hasList = false;
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      childCount = children.length;
      hasList = children.some((c) => c.getType() === 'list');
    });
    expect(childCount).toBeGreaterThan(3);
    expect(hasList).toBe(true);
  });
});
