import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import type { CommentActionKind, CommentView } from './commentTypes';

const ACTION_META: Record<CommentActionKind, { label: string; icon: string; testId: string; danger?: boolean }> = {
  reply: { label: 'Reply', icon: 'reply', testId: 'comment-action-reply' },
  edit: { label: 'Edit message', icon: 'edit', testId: 'comment-action-edit' },
  copyLink: { label: 'Copy link to message', icon: 'link', testId: 'comment-action-copy-link' },
  delete: { label: 'Delete message', icon: 'delete', testId: 'comment-action-delete', danger: true },
};

/** Menu order, independent of the order capabilities resolved in. */
const ORDER: CommentActionKind[] = ['reply', 'copyLink', 'edit', 'delete'];

/**
 * Per-message action menu.
 *
 * The item list is `view.actions`, already resolved from capabilities by the
 * view model, so this component makes no permission decision of its own.
 * Positioned with @floating-ui through a portal -- the row lives inside a
 * scrolling, overflow-clipped timeline, which is exactly where hand-computed
 * fixed coordinates break.
 */
export function CommentActionMenu({
  view,
  onAction,
}: {
  view: CommentView;
  onAction: (action: CommentActionKind, view: CommentView) => void;
}) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const items = ORDER.filter((action) => view.actions.includes(action));
  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="comment-action-trigger"
        aria-label="Message actions"
        aria-expanded={menu.isOpen}
        title="Message actions"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        className={`comment-action-trigger flex size-6 items-center justify-center rounded border text-[var(--nim-text-muted)] ${
          menu.isOpen
            ? 'border-[var(--nim-primary)] bg-[var(--nim-bg-hover)]'
            : 'border-transparent hover:border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]'
        }`}
      >
        <MaterialSymbol icon="more_horiz" size={16} />
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            data-testid="comment-action-menu"
            className="comment-action-menu z-[10000] min-w-[196px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
          >
            {items.map((action) => {
              const meta = ACTION_META[action];
              return (
                <button
                  key={action}
                  type="button"
                  data-testid={meta.testId}
                  className={`comment-action-item flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-[var(--nim-bg-hover)] ${
                    meta.danger ? 'text-[var(--nim-error)]' : 'text-[var(--nim-text)]'
                  }`}
                  onClick={() => {
                    menu.setIsOpen(false);
                    onAction(action, view);
                  }}
                >
                  <MaterialSymbol icon={meta.icon} size={16} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
