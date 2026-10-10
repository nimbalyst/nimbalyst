/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {JSX} from 'react';

import './index.css';

import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import {
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  LinkNode,
} from '@lexical/link';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$findMatchingParent, mergeRegister} from '@lexical/utils';
import {
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  isDOMNode,
  KEY_ESCAPE_COMMAND,
  NodeKey,
} from 'lexical';
import {Dispatch, useCallback, useEffect, useReducer, useRef, useState} from 'react';
import * as React from 'react';

import {useDocumentPath} from '../../../DocumentPathContext';
import {MaterialSymbol} from '../../../ui/icons/MaterialSymbol';
import {getSelectedNode} from '../../utils/getSelectedNode';
import {sanitizeUrl} from '../../utils/url';
import {
  isWorkspaceFileHref,
  openLinkWithHost,
  openWorkspaceFileLink,
} from '../../utils/workspaceLinkNavigation';

/**
 * Links behave like links: a plain click opens them, in edit mode too.
 *
 * - Pointer resting on a link shows a small card (Edit, copy, URL).
 * - Caret inside a link's text (keyboard or drag-select) shows the edit form
 *   directly, without taking focus, so arrow keys keep moving through the
 *   document. Focusing a field pins the form until it is saved or dismissed.
 * - The toolbar / Cmd+K on a selection opens the form with the URL focused.
 *
 * A click that only places the caret never shows anything, so clicking a
 * link does not leave a popup behind.
 */

const HOVER_OPEN_DELAY_MS = 300;
// Long enough to travel from the link into the card and reach its buttons.
const HOVER_CLOSE_DELAY_MS = 500;
/** URL a freshly inserted link starts with; cancelling leaves no link behind. */
const PLACEHOLDER_URL = 'https://';

function $getLinkFromDOM(target: Node): LinkNode | null {
  const node = $getNearestNodeFromDOMNode(target);
  if (node === null) {
    return null;
  }
  const link = $findMatchingParent(node, $isLinkNode);
  if (link === null || ($isAutoLinkNode(link) && link.getIsUnlinked())) {
    return null;
  }
  return link;
}

/** The link the selection sits inside, when the selection stays within one link. */
function $getSelectionLink(): LinkNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return null;
  }
  const link = $findMatchingParent(getSelectedNode(selection), $isLinkNode);
  if (link === null || ($isAutoLinkNode(link) && link.getIsUnlinked())) {
    return null;
  }
  const withinLink = selection
    .getNodes()
    .every(
      (node) => $isLineBreakNode(node) || link.is(node) || link.isParentOf(node),
    );
  return withinLink ? link : null;
}

function $unwrapLink(link: LinkNode): void {
  for (const child of link.getChildren()) {
    link.insertBefore(child);
  }
  link.remove();
}

/** Replace a link's text, keeping the formatting of its first text run. */
function $setLinkText(link: LinkNode, text: string): void {
  if (text === '' || text === link.getTextContent()) {
    return;
  }
  const first = link.getAllTextNodes()[0];
  const replacement = $createTextNode(text);
  if (first) {
    replacement.setFormat(first.getFormat());
    replacement.setStyle(first.getStyle());
  }
  // Append before removing: a link that is ever empty removes itself.
  const previous = link.getChildren();
  link.append(replacement);
  for (const child of previous) {
    child.remove();
  }
}

const HOVER_ZONE_PADDING_PX = 8;

/** True when the point is over the link, the card, or the band joining them. */
export function isPointInHoverZone(
  x: number,
  y: number,
  link: Element,
  card: Element,
): boolean {
  const a = link.getBoundingClientRect();
  const b = card.getBoundingClientRect();
  const pad = HOVER_ZONE_PADDING_PX;
  return (
    x >= Math.min(a.left, b.left) - pad &&
    x <= Math.max(a.right, b.right) + pad &&
    y >= Math.min(a.top, b.top) - pad &&
    y <= Math.max(a.bottom, b.bottom) + pad
  );
}

/**
 * Open a link's URL. File paths go through the host's document opener and
 * never reach `window.open`, which in Electron resolves them against the
 * renderer origin and spawns a blank window (NIM-1487).
 */
export function openLinkUrl(
  url: string,
  documentPath: string | null,
  options: {newTab: boolean} = {newTab: false},
): void {
  if (isWorkspaceFileHref(url)) {
    openWorkspaceFileLink(url, documentPath);
    return;
  }
  if (openLinkWithHost(url, options)) {
    return;
  }
  window.open(sanitizeUrl(url), '_blank', 'noopener,noreferrer');
}

function isNewTabClick(event: MouseEvent | React.MouseEvent): boolean {
  return event.button === 1 || event.metaKey || event.ctrlKey;
}

function preventDefault(event: React.MouseEvent<HTMLElement>): void {
  event.preventDefault();
}

export default function FloatingLinkEditorPlugin({
  isLinkEditMode,
  setIsLinkEditMode,
}: {
  isLinkEditMode: boolean;
  setIsLinkEditMode: Dispatch<boolean>;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const {documentPath} = useDocumentPath();
  const documentPathRef = useRef<string | null>(documentPath ?? null);
  documentPathRef.current = documentPath ?? null;

  const [hoverKey, setHoverKey] = useState<NodeKey | null>(null);
  const [caretKey, setCaretKey] = useState<NodeKey | null>(null);
  // The link a focused form is editing, pinned against selection changes.
  const [editKey, setEditKey] = useState<NodeKey | null>(null);
  // The caret form follows the keyboard and drag-selection, never a click.
  const [caretFormSuppressed, setCaretFormSuppressed] = useState(true);
  const [draftText, setDraftText] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  const caretFormKey = caretFormSuppressed ? null : caretKey;
  const activeKey = isLinkEditMode
    ? editKey ?? caretKey
    : caretFormKey ?? hoverKey;
  const showForm = isLinkEditMode || (activeKey !== null && activeKey === caretFormKey);

  const activeLink =
    activeKey === null
      ? null
      : editor.read(() => {
          const node = $getNodeByKey(activeKey);
          return $isLinkNode(node)
            ? {url: node.getURL(), text: node.getTextContent()}
            : null;
        });
  const activeElement =
    activeKey === null ? null : editor.getElementByKey(activeKey);
  const isOpen = activeLink !== null && activeElement !== null;

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const isLinkEditModeRef = useRef(isLinkEditMode);
  isLinkEditModeRef.current = isLinkEditMode;
  const editKeyRef = useRef(editKey);
  editKeyRef.current = editKey;
  const activeLinkRef = useRef(activeLink);
  activeLinkRef.current = activeLink;

  const cardRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const pendingHoverKeyRef = useRef<NodeKey | null>(null);
  // Edits started from the toolbar or the caret hand focus back to the editor.
  const refocusEditorOnEndRef = useRef(false);

  const {refs, floatingStyles} = useFloating({
    open: isOpen,
    elements: {reference: activeElement},
    placement: 'bottom-start',
    middleware: [offset(6), flip({padding: 8}), shift({padding: 8})],
    whileElementsMounted: autoUpdate,
  });

  const clearHoverTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    pendingHoverKeyRef.current = null;
  }, []);

  const scheduleHoverHide = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      pendingHoverKeyRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      return;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHoverKey(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, []);

  const cancelHoverHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearHoverTimers, [clearHoverTimers]);

  // While the hover card is up, the pointer position decides whether it stays:
  // anywhere over the link, the card, or the gap between them keeps it open.
  // Enter/leave events alone miss the trip from the link to the card's buttons.
  const hoverCardOpen = isOpen && !showForm && activeKey === hoverKey;
  useEffect(() => {
    if (!hoverCardOpen || hoverKey === null) {
      return;
    }
    const onMouseMove = (event: MouseEvent) => {
      const card = cardRef.current;
      const link = editor.getElementByKey(hoverKey);
      if (card === null || link === null) {
        return;
      }
      if (isPointInHoverZone(event.clientX, event.clientY, link, card)) {
        cancelHoverHide();
      } else {
        scheduleHoverHide();
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    return () => document.removeEventListener('mousemove', onMouseMove);
  }, [hoverCardOpen, hoverKey, editor, cancelHoverHide, scheduleHoverHide]);

  // Pointer: click opens, hover shows the card, a press hides the caret form.
  useEffect(() => {
    const onMouseOver = (event: MouseEvent) => {
      const target = event.target;
      if (!isDOMNode(target)) {
        return;
      }
      const key = editor.read(() => $getLinkFromDOM(target)?.getKey() ?? null);
      if (key === null) {
        scheduleHoverHide();
        return;
      }
      cancelHoverHide();
      if (pendingHoverKeyRef.current === key) {
        return;
      }
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
      }
      pendingHoverKeyRef.current = key;
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        pendingHoverKeyRef.current = null;
        setHoverKey(key);
      }, HOVER_OPEN_DELAY_MS);
    };

    const onMouseDown = () => {
      setCaretFormSuppressed(true);
    };

    const onMouseUp = () => {
      // A drag that selects text inside a link puts the caret there on purpose.
      window.setTimeout(() => {
        const hasRangeSelection = editor.read(() => {
          const selection = $getSelection();
          return $isRangeSelection(selection) && !selection.isCollapsed();
        });
        if (hasRangeSelection) {
          setCaretFormSuppressed(false);
        }
      }, 0);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Escape dismisses the form; it must not bring it straight back.
      if (event.key !== 'Escape') {
        setCaretFormSuppressed(false);
      }
    };

    const onClick = (event: MouseEvent) => {
      const isMiddle = event.type === 'auxclick' && event.button === 1;
      // DocumentLinkPlugin claims file references and app actions first.
      if (event.defaultPrevented || (event.button !== 0 && !isMiddle)) {
        return;
      }
      const target = event.target;
      if (!isDOMNode(target)) {
        return;
      }
      const url = editor.read(() => $getLinkFromDOM(target)?.getURL() ?? null);
      if (url === null || url === '') {
        return;
      }
      event.preventDefault();
      // Dragging across a link selects its text instead of following it.
      const hasRangeSelection = editor.read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) && !selection.isCollapsed();
      });
      if (hasRangeSelection) {
        return;
      }
      clearHoverTimers();
      setHoverKey(null);
      openLinkUrl(url, documentPathRef.current, {newTab: isNewTabClick(event)});
    };

    return editor.registerRootListener((rootElement, prevRootElement) => {
      const detach = (element: HTMLElement) => {
        element.removeEventListener('mouseover', onMouseOver);
        element.removeEventListener('mouseleave', scheduleHoverHide);
        element.removeEventListener('mousedown', onMouseDown);
        element.removeEventListener('mouseup', onMouseUp);
        element.removeEventListener('keydown', onKeyDown);
        element.removeEventListener('click', onClick);
        element.removeEventListener('auxclick', onClick);
      };
      if (prevRootElement) {
        detach(prevRootElement);
      }
      if (rootElement) {
        rootElement.addEventListener('mouseover', onMouseOver);
        rootElement.addEventListener('mouseleave', scheduleHoverHide);
        rootElement.addEventListener('mousedown', onMouseDown);
        rootElement.addEventListener('mouseup', onMouseUp);
        rootElement.addEventListener('keydown', onKeyDown);
        rootElement.addEventListener('click', onClick);
        rootElement.addEventListener('auxclick', onClick);
        return () => detach(rootElement);
      }
      return undefined;
    });
  }, [editor, cancelHoverHide, clearHoverTimers, scheduleHoverHide]);

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        const key = editorState.read(() =>
          editor.isEditable() ? $getSelectionLink()?.getKey() ?? null : null,
        );
        setCaretKey(key);
        // A toolbar edit that never produced a link has nothing to edit.
        if (key === null && isLinkEditModeRef.current && editKeyRef.current === null) {
          setIsLinkEditMode(false);
        }
        if (isOpenRef.current) {
          refresh();
        }
      }),
      editor.registerCommand(
        BLUR_COMMAND,
        (event) => {
          // Focus moving into the form is how the caret form gets edited.
          const next = event.relatedTarget;
          if (!(next instanceof Node && cardRef.current?.contains(next))) {
            setCaretFormSuppressed(true);
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (!isOpenRef.current || isLinkEditModeRef.current) {
            return false;
          }
          clearHoverTimers();
          setHoverKey(null);
          setCaretFormSuppressed(true);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, clearHoverTimers, setIsLinkEditMode]);

  const beginEdit = useCallback(
    (key: NodeKey, refocusEditorOnEnd: boolean) => {
      const link = activeLinkRef.current;
      setDraftText(link?.text ?? '');
      setDraftUrl(link?.url ?? '');
      refocusEditorOnEndRef.current = refocusEditorOnEnd;
      clearHoverTimers();
      setEditKey(key);
      setIsLinkEditMode(true);
    },
    [clearHoverTimers, setIsLinkEditMode],
  );

  // The toolbar / Cmd+K flow turns on edit mode before the link exists; pin
  // the link once the caret lands in it and focus its URL.
  useEffect(() => {
    if (isLinkEditMode && isOpen && editKey === null && activeKey !== null) {
      beginEdit(activeKey, true);
      urlInputRef.current?.focus();
    }
  }, [isLinkEditMode, isOpen, editKey, activeKey, beginEdit]);

  const endEdit = useCallback(
    (refocusEditor: boolean) => {
      const refocus = refocusEditor && refocusEditorOnEndRef.current;
      refocusEditorOnEndRef.current = false;
      setIsLinkEditMode(false);
      setEditKey(null);
      setHoverKey(null);
      setCaretFormSuppressed(true);
      if (refocus) {
        editor.focus();
      }
    },
    [editor, setIsLinkEditMode],
  );

  const cancelEdit = useCallback(
    (refocusEditor: boolean) => {
      const key = activeKey;
      if (key !== null) {
        editor.update(() => {
          const node = $getNodeByKey(key);
          if ($isLinkNode(node) && node.getURL() === PLACEHOLDER_URL) {
            $unwrapLink(node);
          }
        });
      }
      endEdit(refocusEditor);
    },
    [activeKey, editor, endEdit],
  );

  // An unpinned caret form shows the live link; a pinned one shows the drafts.
  const textValue = isLinkEditMode ? draftText : activeLink?.text ?? '';
  const urlValue = isLinkEditMode ? draftUrl : activeLink?.url ?? '';

  const saveEdit = useCallback(() => {
    const key = activeKey;
    const text = textValue.trim();
    const url = urlValue.trim();
    if (key !== null) {
      editor.update(() => {
        const node = $getNodeByKey(key);
        if (!$isLinkNode(node)) {
          return;
        }
        if (url === '' || url === PLACEHOLDER_URL) {
          $setLinkText(node, text);
          $unwrapLink(node);
          return;
        }
        let link = node;
        if ($isAutoLinkNode(node)) {
          // An edited autolink is no longer derived from its text.
          link = $createLinkNode(url, {
            rel: node.getRel(),
            target: node.getTarget(),
            title: node.getTitle(),
          });
          node.replace(link, true);
        } else {
          link.setURL(url);
        }
        $setLinkText(link, text);
      });
    }
    endEdit(true);
  }, [activeKey, editor, endEdit, textValue, urlValue]);

  const removeLink = useCallback(() => {
    const key = activeKey;
    if (key !== null) {
      editor.update(() => {
        const node = $getNodeByKey(key);
        if ($isLinkNode(node)) {
          $unwrapLink(node);
        }
      });
    }
    endEdit(true);
  }, [activeKey, editor, endEdit]);

  const copyUrl = useCallback(() => {
    if (activeLink === null) {
      return;
    }
    void navigator.clipboard?.writeText(activeLink.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [activeLink]);

  if (!isOpen || activeLink === null || activeKey === null) {
    return null;
  }

  const activeUrl = activeLink.url;
  const isFileLink = isWorkspaceFileHref(activeUrl);

  const onFieldFocus = () => {
    if (!isLinkEditMode) {
      beginEdit(activeKey, true);
    }
  };

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(true);
    }
  };

  return (
    <FloatingPortal>
      <div
        ref={(node) => {
          cardRef.current = node;
          refs.setFloating(node);
        }}
        style={floatingStyles}
        className={`link-editor ${showForm ? 'link-editor-form' : ''}`}
        data-testid="link-hover-card"
        onBlur={(event) => {
          if (
            isLinkEditMode &&
            !cardRef.current?.contains(event.relatedTarget as Node | null)
          ) {
            cancelEdit(false);
          }
        }}>
        {showForm ? (
          <>
            <label className="link-field">
              <span className="link-field-label">Text</span>
              <input
                className="link-input"
                value={textValue}
                aria-label="Link text"
                onFocus={onFieldFocus}
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={onFieldKeyDown}
              />
            </label>
            <label className="link-field">
              <span className="link-field-label">Link</span>
              <input
                ref={urlInputRef}
                className="link-input"
                value={urlValue}
                placeholder="Paste or type a link"
                aria-label="Link URL"
                onFocus={onFieldFocus}
                onChange={(event) => setDraftUrl(event.target.value)}
                onKeyDown={onFieldKeyDown}
              />
            </label>
            <div className="link-form-actions">
              <button
                type="button"
                className="link-editor-text-button link-remove"
                onMouseDown={preventDefault}
                onClick={removeLink}>
                <MaterialSymbol icon="link_off" size={16} />
                Remove link
              </button>
              {isLinkEditMode && (
                <button
                  type="button"
                  className="link-editor-text-button link-save"
                  onMouseDown={preventDefault}
                  onClick={saveEdit}>
                  Save
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="link-view">
            {editor.isEditable() && (
              <button
                type="button"
                className="link-editor-text-button"
                onMouseDown={preventDefault}
                onClick={() => {
                  beginEdit(activeKey, false);
                  // The field mounts on the next render.
                  window.setTimeout(() => urlInputRef.current?.focus(), 0);
                }}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="link-editor-icon-button"
              title={copied ? 'Copied' : 'Copy link'}
              aria-label="Copy link"
              onMouseDown={preventDefault}
              onClick={copyUrl}>
              <MaterialSymbol icon={copied ? 'check' : 'content_copy'} size={16} />
            </button>
            <span className="link-view-divider" />
            <MaterialSymbol
              icon={isFileLink ? 'description' : 'language'}
              size={16}
              className="link-view-icon"
            />
            <a
              className="link-view-url"
              href={isFileLink ? activeUrl : sanitizeUrl(activeUrl)}
              title={activeUrl}
              onClick={(event) => {
                event.preventDefault();
                clearHoverTimers();
                setHoverKey(null);
                openLinkUrl(activeUrl, documentPathRef.current, {
                  newTab: isNewTabClick(event),
                });
              }}>
              {activeUrl}
            </a>
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
