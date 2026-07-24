/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {
  $getTableAndElementByKey,
  $getTableColumnIndexFromTableCellNode,
  $getTableRowIndexFromTableCellNode,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  getTableElement,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {$findMatchingParent, mergeRegister} from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode,
  EditorThemeClasses,
  isHTMLElement,
  NodeKey,
} from 'lexical';
import {useEffect, useMemo, useRef, useState} from 'react';
import * as React from 'react';
import {createPortal} from 'react-dom';

import {getThemeSelector} from '../../utils/getThemeSelector';
import {useDebounce} from '../CodeActionMenuPlugin/utils';

const BUTTON_WIDTH_PX = 20;

function TableHoverActionsContainer({
  anchorElem,
}: {
  anchorElem: HTMLElement;
}): JSX.Element | null {
  const [editor, {getTheme}] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const [isShownRow, setShownRow] = useState<boolean>(false);
  const [isShownColumn, setShownColumn] = useState<boolean>(false);
  const [shouldListenMouseMove, setShouldListenMouseMove] =
    useState<boolean>(false);
  const [position, setPosition] = useState({});
  const tableSetRef = useRef<Set<NodeKey>>(new Set());
  const tableCellDOMNodeRef = useRef<HTMLElement | null>(null);

  const debouncedOnMouseMove = useDebounce(
    (event: MouseEvent) => {
      const {isOutside, tableDOMNode} = getMouseInfo(event, getTheme);

      if (isOutside) {
        setShownRow(false);
        setShownColumn(false);
        return;
      }

      if (!tableDOMNode) {
        return;
      }

      tableCellDOMNodeRef.current = tableDOMNode;

      let hoveredRowNode: TableCellNode | null = null;
      let hoveredColumnNode: TableCellNode | null = null;
      let tableDOMElement: HTMLElement | null = null;

      editor.getEditorState().read(
        () => {
          const maybeTableCell = $getNearestNodeFromDOMNode(tableDOMNode);

          if ($isTableCellNode(maybeTableCell)) {
            const table = $findMatchingParent(maybeTableCell, (node) =>
              $isTableNode(node),
            );
            if (!$isTableNode(table)) {
              return;
            }

            tableDOMElement = getTableElement(
              table,
              editor.getElementByKey(table.getKey()),
            );

            if (tableDOMElement) {
              const rowCount = table.getChildrenSize();
              const colCount = (
                (table as TableNode).getChildAtIndex(0) as TableRowNode
              )?.getChildrenSize();

              const rowIndex =
                $getTableRowIndexFromTableCellNode(maybeTableCell);
              const colIndex =
                $getTableColumnIndexFromTableCellNode(maybeTableCell);

              if (rowIndex === rowCount - 1) {
                hoveredRowNode = maybeTableCell;
              } else if (colIndex === colCount - 1) {
                hoveredColumnNode = maybeTableCell;
              }
            }
          }
        },
        {editor},
      );

      if (tableDOMElement) {
        const {
          width: tableElemWidth,
          y: tableElemY,
          right: tableElemRight,
          left: tableElemLeft,
          bottom: tableElemBottom,
          height: tableElemHeight,
        } = (tableDOMElement as HTMLTableElement).getBoundingClientRect();

        // Adjust for using the scrollable table container
        const parentElement = (tableDOMElement as HTMLTableElement)
          .parentElement;
        let tableHasScroll = false;
        if (
          parentElement &&
          parentElement.classList.contains(
            'nim-table-scrollable-wrapper',
          )
        ) {
          tableHasScroll =
            parentElement.scrollWidth > parentElement.clientWidth;
        }
        // POSITIONING: The buttons are portaled into anchorElem (editor-scroller) which has
        // position: relative and overflow: auto. To position correctly:
        // 1. Use getBoundingClientRect() to get viewport-relative coordinates
        // 2. Subtract anchorRect to get position relative to anchorElem
        // 3. Add anchorElem.scrollTop/Left to account for scroll offset within anchorElem
        // This ensures the buttons scroll with content and appear at the correct position.
        const anchorRect = anchorElem.getBoundingClientRect();

        if (hoveredRowNode) {
          setShownColumn(false);
          setShownRow(true);
          setPosition({
            height: BUTTON_WIDTH_PX,
            left:
              tableHasScroll && parentElement
                ? parentElement.offsetLeft
                : tableElemLeft - anchorRect.left + anchorElem.scrollLeft,
            top: tableElemBottom - anchorRect.top + anchorElem.scrollTop + 5,
            width:
              tableHasScroll && parentElement
                ? parentElement.offsetWidth
                : tableElemWidth,
          });
        } else if (hoveredColumnNode) {
          setShownColumn(true);
          setShownRow(false);
          setPosition({
            height: tableElemHeight,
            left: tableElemRight - anchorRect.left + anchorElem.scrollLeft + 5,
            top: tableElemY - anchorRect.top + anchorElem.scrollTop,
            width: BUTTON_WIDTH_PX,
          });
        }
      }
    },
    50,
    250,
  );

  // Hide the buttons on any table dimensions change to prevent last row cells
  // overlap behind the 'Add Row' button when text entry changes cell height
  const tableResizeObserver = useMemo(() => {
    return new ResizeObserver(() => {
      setShownRow(false);
      setShownColumn(false);
    });
  }, []);

  useEffect(() => {
    if (!shouldListenMouseMove) {
      return;
    }

    document.addEventListener('mousemove', debouncedOnMouseMove);

    return () => {
      setShownRow(false);
      setShownColumn(false);
      debouncedOnMouseMove.cancel();
      document.removeEventListener('mousemove', debouncedOnMouseMove);
    };
  }, [shouldListenMouseMove, debouncedOnMouseMove]);

  useEffect(() => {
    return mergeRegister(
      editor.registerMutationListener(
        TableNode,
        (mutations) => {
          editor.getEditorState().read(
            () => {
              let resetObserver = false;
              for (const [key, type] of mutations) {
                switch (type) {
                  case 'created': {
                    tableSetRef.current.add(key);
                    resetObserver = true;
                    break;
                  }
                  case 'destroyed': {
                    tableSetRef.current.delete(key);
                    resetObserver = true;
                    break;
                  }
                  default:
                    break;
                }
              }
              if (resetObserver) {
                // Reset resize observers
                tableResizeObserver.disconnect();
                for (const tableKey of tableSetRef.current) {
                  const {tableElement} = $getTableAndElementByKey(tableKey);
                  tableResizeObserver.observe(tableElement);
                }
                setShouldListenMouseMove(tableSetRef.current.size > 0);
              }
            },
            {editor},
          );
        },
        {skipInitialization: false},
      ),
    );
  }, [editor, tableResizeObserver]);

  const insertAction = (insertRow: boolean) => {
    editor.update(() => {
      if (tableCellDOMNodeRef.current) {
        const maybeTableNode = $getNearestNodeFromDOMNode(
          tableCellDOMNodeRef.current,
        );
        maybeTableNode?.selectEnd();
        if (insertRow) {
          $insertTableRowAtSelection();
          setShownRow(false);
        } else {
          $insertTableColumnAtSelection();
          setShownColumn(false);
        }
      }
    });
  };

  if (!isEditable) {
    return null;
  }

  return (
    <>
      {isShownRow && (
        <button
          className={`${getTheme()?.tableAddRows}`}
          style={{...position}}
          onClick={() => insertAction(true)}
        />
      )}
      {isShownColumn && (
        <button
          className={`${getTheme()?.tableAddColumns}`}
          style={{...position}}
          onClick={() => insertAction(false)}
        />
      )}
    </>
  );
}

function getMouseInfo(
  event: MouseEvent,
  getTheme: () => EditorThemeClasses | null | undefined,
): {
  tableDOMNode: HTMLElement | null;
  isOutside: boolean;
} {
  const target = event.target;
  const tableCellClass = getThemeSelector(getTheme, 'tableCell');

  if (isHTMLElement(target)) {
    const tableDOMNode = target.closest<HTMLElement>(
      `td${tableCellClass}, th${tableCellClass}`,
    );

    const isOutside = !(
      tableDOMNode ||
      target.closest<HTMLElement>(
        `button${getThemeSelector(getTheme, 'tableAddRows')}`,
      ) ||
      target.closest<HTMLElement>(
        `button${getThemeSelector(getTheme, 'tableAddColumns')}`,
      ) ||
      target.closest<HTMLElement>('div.TableCellResizer__resizer')
    );

    return {isOutside, tableDOMNode};
  } else {
    return {isOutside: true, tableDOMNode: null};
  }
}

export default function TableHoverActionsPlugin({
  anchorElem = document.body,
}: {
  anchorElem?: HTMLElement;
}): React.ReactPortal | null {
  const isEditable = useLexicalEditable();

  // PORTAL TARGET: Use anchorElem (editor-scroller) as the portal container.
  // This element has position: relative and overflow: auto, making it the
  // correct target for absolutely positioned floating elements that should
  // scroll with the editor content. Position calculations in the container
  // account for anchorElem's scroll offset.
  return isEditable
    ? createPortal(
        <TableHoverActionsContainer anchorElem={anchorElem} />,
        anchorElem,
      )
    : null;
}
