/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {TableOfContentsEntry} from '@lexical/react/LexicalTableOfContentsPlugin';
import type {HeadingTagType} from '@lexical/rich-text';
import type {NodeKey} from 'lexical';
import type {JSX} from 'react';

import './index.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {TableOfContentsPlugin as LexicalTableOfContentsPlugin} from '@lexical/react/LexicalTableOfContentsPlugin';
import {useEffect, useState, useCallback} from 'react';
import DropDown, {DropDownItem} from '../../ui/DropDown';

function getIndentClass(tagName: HeadingTagType): string {
  if (tagName === 'h2') {
    return 'toc-heading-2';
  } else if (tagName === 'h3') {
    return 'toc-heading-3';
  }
  return 'toc-heading-1';
}

function TableOfContentsDropdown({
  tableOfContents,
  disabled = false,
}: {
  tableOfContents: Array<TableOfContentsEntry>;
  disabled?: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [activeHeadingKey, setActiveHeadingKey] = useState<NodeKey | null>(null);

  // Find the topmost visible heading in the viewport
  const updateActiveHeading = useCallback(() => {
    const headings = tableOfContents.map(([key]) => {
      const element = editor.getElementByKey(key);
      if (!element) return null;
      
      const rect = element.getBoundingClientRect();
      return { key, top: rect.top, element };
    }).filter(Boolean);

    // Find the last heading that's above or at the top of the viewport
    // with some offset to account for the toolbar
    const OFFSET = 100;
    let activeKey = null;
    
    for (let i = headings.length - 1; i >= 0; i--) {
      const heading = headings[i];
      if (heading && heading.top <= OFFSET) {
        activeKey = heading.key;
        break;
      }
    }
    
    // If no heading is above the viewport, use the first visible one
    if (!activeKey && headings.length > 0) {
      const firstVisible = headings.find(h => h && h.top < window.innerHeight);
      if (firstVisible) {
        activeKey = firstVisible.key;
      }
    }
    
    setActiveHeadingKey(activeKey);
  }, [tableOfContents, editor]);

  useEffect(() => {
    updateActiveHeading();
    
    const handleScroll = () => {
      updateActiveHeading();
    };
    
    // Listen to both window and potential scrollable parent
    window.addEventListener('scroll', handleScroll);
    document.addEventListener('scroll', handleScroll, true);
    
    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [updateActiveHeading]);

  function scrollToNode(key: NodeKey) {
    editor.getEditorState().read(() => {
      const domElement = editor.getElementByKey(key);
      if (domElement !== null) {
        domElement.scrollIntoView({behavior: 'smooth', block: 'center'});
      }
    });
  }

  // Filter to only include h1, h2, h3
  const filteredTableOfContents = tableOfContents.filter(([, , tag]) =>
    tag === 'h1' || tag === 'h2' || tag === 'h3'
  );
  const hasHeaders = filteredTableOfContents.length > 0;

  return (
    <DropDown
      disabled={disabled || !hasHeaders}
        className="table-of-contents"
      buttonIconClassName="icon table-of-contents"
      buttonAriaLabel="Table of Contents"
      buttonClassName="toolbar-item spaced">
      {filteredTableOfContents.map(([key, text, tag]) => (
        <DropDownItem
          key={key}
          className={`item toc-item ${getIndentClass(tag)} ${activeHeadingKey === key ? 'active-heading' : ''}`}
          onClick={() => scrollToNode(key)}>
          {activeHeadingKey === key && (
            <span className="active-indicator">•</span>
          )}
          <span className="text">{text}</span>
        </DropDownItem>
      ))}
      {!hasHeaders && (
        <DropDownItem
          className="item toc-item-empty"
          onClick={() => {}}>
          <span className="text">No headers found</span>
        </DropDownItem>
      )}
    </DropDown>
  );
}

export default function TableOfContentsDropdownPlugin({
  disabled = false,
}: {
  disabled?: boolean;
}): JSX.Element {
  return (
    <LexicalTableOfContentsPlugin>
      {(tableOfContents) => (
        <TableOfContentsDropdown
          tableOfContents={tableOfContents}
          disabled={disabled}
        />
      )}
    </LexicalTableOfContentsPlugin>
  );
}
