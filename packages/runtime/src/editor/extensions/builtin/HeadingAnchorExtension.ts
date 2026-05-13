/**
 * Assigns GitHub-style slug ids to rendered heading elements so anchor
 * links like `[Section](#section)` have a target to scroll to. The
 * stock `@lexical/rich-text` `HeadingNode.createDOM()` emits
 * `<h1>...<h6>` with no id, so without this extension the renderer's
 * link click handler has nothing to query.
 *
 * Headless extension: registers a mutation listener directly on the
 * editor instance instead of mounting a React plugin. Scoped to
 * `editor.getRootElement()` so each open editor manages its own
 * heading ids (multi-file safe).
 */

import { defineExtension, type LexicalEditor } from 'lexical';
import { HeadingNode } from '@lexical/rich-text';

import { slugify } from '../../utils/headingSlug';

function recomputeHeadingIds(editor: LexicalEditor): void {
  const root = editor.getRootElement();
  if (!root) {
    return;
  }
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const taken = new Map<string, number>();
  headings.forEach((element) => {
    const text = element.textContent ?? '';
    const slug = slugify(text);
    if (!slug) {
      if (element.id) {
        element.removeAttribute('id');
      }
      return;
    }
    let candidate = slug;
    const count = taken.get(slug);
    if (count !== undefined) {
      const next = count + 1;
      candidate = `${slug}-${next}`;
      taken.set(slug, next);
    } else {
      taken.set(slug, 0);
    }
    if (element.id !== candidate) {
      element.id = candidate;
    }
  });
}

export const HeadingAnchorExtension = defineExtension({
  name: '@nimbalyst/editor/heading-anchor',
  register: (editor) => {
    recomputeHeadingIds(editor);
    return editor.registerMutationListener(
      HeadingNode,
      () => {
        recomputeHeadingIds(editor);
      },
      { skipInitialization: false },
    );
  },
});
