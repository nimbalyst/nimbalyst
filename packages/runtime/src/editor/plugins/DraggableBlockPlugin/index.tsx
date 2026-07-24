/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {JSX} from 'react';

import './index.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';
import {$createParagraphNode, $getNearestNodeFromDOMNode} from 'lexical';
import {useRef, useState, useEffect, useCallback} from 'react';
import {draggableBlockMenuRegistry, DraggableBlockMenuItem} from './DraggableBlockMenuRegistry';

const DRAGGABLE_BLOCK_MENU_CLASSNAME = 'draggable-block-menu';

function isOnMenu(element: HTMLElement): boolean {
  return !!element.closest(`.${DRAGGABLE_BLOCK_MENU_CLASSNAME}`);
}

export default function DraggableBlockPlugin({
  anchorElem = document.body,
}: {
  anchorElem?: HTMLElement;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const menuRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [draggableElement, setDraggableElement] = useState<HTMLElement | null>(
    null,
  );
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentNode, setCurrentNode] = useState<any>(null);
  const [menuItems, setMenuItems] = useState<DraggableBlockMenuItem[]>([]);

  function insertBlock(e: React.MouseEvent) {
    if (!draggableElement || !editor) {
      return;
    }

    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(draggableElement);
      if (!node) {
        return;
      }

      const pNode = $createParagraphNode();
      if (e.altKey || e.ctrlKey) {
        node.insertBefore(pNode);
      } else {
        node.insertAfter(pNode);
      }
      pNode.select();
    });
  }

  const deleteNode = useCallback(() => {
    if (!draggableElement || !editor) {
      return;
    }

    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(draggableElement);
      if (!node) {
        return;
      }
      node.remove();
    });

    setShowDropdown(false);
  }, [draggableElement, editor]);

  const toggleDropdown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDropdown(prev => !prev);
  }, []);

  // Update menu items when draggable element changes
  useEffect(() => {
    if (draggableElement && editor) {
      editor.read(() => {
        const node = $getNearestNodeFromDOMNode(draggableElement);
        if (node) {
          setCurrentNode(node);
          const items = draggableBlockMenuRegistry.getMenuItemsForNode(node);
          setMenuItems(items);
        }
      });
    } else {
      setCurrentNode(null);
      setMenuItems([]);
    }
  }, [draggableElement, editor]);

  // Listen for registry changes
  useEffect(() => {
    const unsubscribe = draggableBlockMenuRegistry.addListener(() => {
      if (currentNode) {
        const items = draggableBlockMenuRegistry.getMenuItemsForNode(currentNode);
        setMenuItems(items);
      }
    });
    return unsubscribe;
  }, [currentNode]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDropdown]);

  return (
    <DraggableBlockPlugin_EXPERIMENTAL
      anchorElem={anchorElem}
      menuRef={menuRef}
      targetLineRef={targetLineRef}
      menuComponent={
        <div ref={menuRef} className="icon draggable-block-menu">
          <button
            title="Click to add below"
            className="icon icon-plus"
            onClick={insertBlock}
          />
          <div className="icon draggable-handle" onClick={toggleDropdown} />
          {showDropdown && (
            <div ref={dropdownRef} className="draggable-dropdown">
              <button onClick={deleteNode} className="dropdown-item">
                <span className="material-symbols-outlined">delete</span>
                Delete
              </button>
              {menuItems.length > 0 && (
                <>
                  <div className="dropdown-divider" />
                  {menuItems.map(item => (
                    <button
                      key={item.id}
                      onClick={() => {
                        if (currentNode) {
                          item.command(editor, currentNode);
                          setShowDropdown(false);
                        }
                      }}
                      className="dropdown-item"
                    >
                      {item.icon && (
                        <span className="material-symbols-outlined">{item.icon}</span>
                      )}
                      {item.label}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      }
      targetLineComponent={
        <div ref={targetLineRef} className="draggable-block-target-line" />
      }
      isOnMenu={isOnMenu}
      onElementChanged={setDraggableElement}
    />
  );
}
