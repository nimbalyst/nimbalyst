/**
 * The rendered ```toc block: the page's headings down to `depth`, kept live
 * from the editor. Clicking an entry scrolls its heading into view.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey } from 'lexical';

import { $isTocNode, parseTocDepth, setTocDepth } from './TocNodeCore';
import { $getTocHeadings, type TocHeading } from './tocHeadings';

const DEPTH_OPTIONS = [1, 2, 3, 4, 5, 6];

function sameHeadings(a: TocHeading[], b: TocHeading[]): boolean {
  return a.length === b.length && a.every((h, i) => (
    h.key === b[i].key && h.text === b[i].text && h.level === b[i].level && h.slug === b[i].slug
  ));
}

export function TocBlock({ source, nodeKey }: { source: string; nodeKey: string }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const depth = parseTocDepth(source);
  const [headings, setHeadings] = useState<TocHeading[]>(() => editor.getEditorState().read(() => $getTocHeadings(depth)));

  useEffect(() => {
    const refresh = () => {
      const next = editor.getEditorState().read(() => $getTocHeadings(depth));
      setHeadings((prev) => (sameHeadings(prev, next) ? prev : next));
    };
    refresh();
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) refresh();
    });
  }, [editor, depth]);

  const onDepthChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number(event.target.value);
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isTocNode(node)) node.setSource(setTocDepth(node.getSource(), next));
    });
  }, [editor, nodeKey]);

  const scrollTo = (event: React.MouseEvent, key: string) => {
    event.preventDefault();
    editor.getElementByKey(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const minLevel = headings.reduce((min, h) => Math.min(min, h.level), 6);

  return (
    <nav className="toc-block my-3 border-l-2 border-nim py-1 pl-4" contentEditable={false}>
      <div className="toc-block-header mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-nim-faint">
        <span>Contents</span>
        {editable ? (
          <select
            className="toc-block-depth bg-transparent text-xs text-nim-faint"
            value={depth}
            onChange={onDepthChange}
            aria-label="Heading depth"
          >
            {DEPTH_OPTIONS.map((level) => (
              <option key={level} value={level}>{`Up to H${level}`}</option>
            ))}
          </select>
        ) : null}
      </div>
      {headings.length === 0 ? (
        <div className="toc-block-empty text-sm text-nim-faint">Add headings to build the table of contents.</div>
      ) : (
        <ul className="toc-block-list m-0 list-none p-0">
          {headings.map((heading) => (
            <li key={heading.key} className="leading-7" style={{ paddingLeft: `${(heading.level - minLevel) * 16}px` }}>
              <a
                className="toc-block-entry text-sm text-nim-muted no-underline hover:text-nim hover:underline"
                href={heading.slug ? `#${heading.slug}` : undefined}
                onClick={(event) => scrollTo(event, heading.key)}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
