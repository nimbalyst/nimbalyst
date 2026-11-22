/**
 * The table of contents button in a document header: the body's headings,
 * one click to scroll to each. Shared by every header that shows a markdown
 * body (local files, shared pages, typed pages), so they offer the same
 * actions in the same place.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { $getRoot } from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { HeaderIconButton } from '@nimbalyst/collab-client/docs-ui/EditorHeaderBar';

/** The slice of a Lexical editor the table of contents reads. */
export interface TableOfContentsEditor {
  getEditorState: () => { read: (fn: () => void) => void };
  registerUpdateListener: (listener: () => void) => () => void;
  getElementByKey: (key: string) => HTMLElement | null;
}

interface TocItem {
  text: string;
  level: number;
  key: string;
}

function readHeadings(editor: TableOfContentsEditor): TocItem[] {
  const items: TocItem[] = [];
  editor.getEditorState().read(() => {
    for (const node of $getRoot().getChildren()) {
      if ($isHeadingNode(node)) {
        items.push({ text: node.getTextContent(), level: Number(node.getTag().slice(1)), key: node.getKey() });
      }
    }
  });
  return items;
}

/**
 * Outline depth of each heading: the number of shallower headings it sits
 * under. A page that starts at H2 is not indented a step for nothing, and an
 * H2 followed directly by an H4 reads as its child, not its grandchild.
 */
export function tocDepths(levels: number[]): number[] {
  const open: number[] = [];
  return levels.map((level) => {
    while (open.length > 0 && open[open.length - 1] >= level) open.pop();
    open.push(level);
    return open.length - 1;
  });
}

const INDENT_BASE_PX = 12;
const INDENT_STEP_PX = 16;

const DEPTH_CLASS: Record<number, string> = {
  0: 'py-2 text-sm font-semibold text-[var(--nim-text)]',
  1: 'py-1.5 text-[13px] text-[var(--nim-text)]',
};
const DEEP_CLASS = 'py-1 text-xs text-[var(--nim-text-muted)]';

export const HeaderTableOfContents: React.FC<{ editor: TableOfContentsEditor }> = ({ editor }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TocItem[]>([]);
  // Read only while open: the list is for the moment the menu is shown.
  useEffect(() => {
    if (!open) return undefined;
    const refresh = () => {
      try {
        setItems(readHeadings(editor));
      } catch (error) {
        console.error('[HeaderTableOfContents] Failed to read headings:', error);
      }
    };
    refresh();
    return editor.registerUpdateListener(refresh);
  }, [editor, open]);
  const depths = useMemo(() => tocDepths(items.map((item) => item.level)), [items]);

  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  return (
    <>
      <HeaderIconButton
        ref={floating.refs.setReference}
        label="Table of Contents"
        haspopup
        active={open}
        onClick={() => setOpen(!open)}
        testId="editor-header-toc"
        {...getReferenceProps()}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </HeaderIconButton>
      {open && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="unified-header-toc-dropdown z-[1000] min-w-[250px] max-w-[350px] max-h-[400px] overflow-y-auto rounded-md bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
          >
            {items.length > 0 ? (
              <ul className="toc-list list-none m-0 py-1 px-0">
                {items.map((item, i) => {
                  const depth = depths[i];
                  return (
                    <li
                      key={item.key}
                      role="menuitem"
                      data-depth={depth}
                      className={`toc-item toc-level-${item.level} pr-3 cursor-pointer leading-snug whitespace-nowrap overflow-hidden text-ellipsis transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] ${DEPTH_CLASS[depth] ?? DEEP_CLASS}`}
                      style={{ paddingLeft: INDENT_BASE_PX + depth * INDENT_STEP_PX }}
                      onClick={() => {
                        editor.getElementByKey(item.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setOpen(false);
                      }}
                    >
                      {item.text}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="toc-empty py-4 px-3 text-center text-[13px] text-[var(--nim-text-muted)]">No headings in document</div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
