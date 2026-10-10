/**
 * A page whose body opens with its own title as a heading (`# Title`, as
 * agents and the wiki guide seed write it) would show the title twice under
 * the page header. The heading stays in the body; this only marks the editor
 * so the page stylesheet hides it while it still matches the title.
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isHeadingNode } from '@lexical/rich-text';
import { $getRoot } from 'lexical';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether a heading's text repeats the page title. */
export function isTitleHeading(headingText: string, title: string): boolean {
  return squash(title) !== '' && squash(headingText) === squash(title);
}

export function useHideTitleHeading(title: string): void {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const sync = () => {
      const repeated = editor.getEditorState().read(() => {
        const first = $getRoot().getFirstChild();
        return $isHeadingNode(first) && first.getTag() === 'h1' && isTitleHeading(first.getTextContent(), title);
      });
      const root = editor.getRootElement();
      // A data attribute, not a class: the editor's own className is React-owned.
      if (repeated) root?.setAttribute('data-title-heading', 'hidden');
      else root?.removeAttribute('data-title-heading');
    };
    sync();
    const offUpdate = editor.registerUpdateListener(sync);
    const offRoot = editor.registerRootListener((root, previous) => {
      previous?.removeAttribute('data-title-heading');
      if (root) sync();
    });
    return () => {
      offUpdate();
      offRoot();
      editor.getRootElement()?.removeAttribute('data-title-heading');
    };
  }, [editor, title]);
}
