/**
 * `@`-mention typeahead list for the comment composer.
 *
 * Purely presentational: the composer owns the query, the filtered candidate
 * list, and the active index, because it also owns the keyboard handling on
 * the text field. This component owns only positioning and the listbox
 * semantics, so it can hang off a textarea, a contenteditable, or any other
 * anchor an editor gives it.
 *
 * Positioned with `@floating-ui/react` through a `FloatingPortal` — never hand
 * -calculated `position: fixed`, which breaks at viewport edges and inside
 * transformed containers such as a zoomed mockup canvas.
 */

import type { JSX } from 'react';

import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';

import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import type { CommentMember } from '../types';

/** Stable id for the option at `index`, for `aria-activedescendant`. */
export function mentionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

export interface CommentMentionPickerProps {
  /** The field the list positions against. */
  referenceElement: HTMLElement | null;
  /** Already filtered and truncated by the caller. */
  candidates: CommentMember[];
  activeIndex: number;
  open: boolean;
  /** Matches the field's `aria-controls`. */
  listboxId: string;
  onSelect(member: CommentMember): void;
  onActiveIndexChange(index: number): void;
  onDismiss(): void;
}

export function CommentMentionPicker({
  referenceElement,
  candidates,
  activeIndex,
  open,
  listboxId,
  onSelect,
  onActiveIndexChange,
  onDismiss,
}: CommentMentionPickerProps): JSX.Element | null {
  const isOpen = open && candidates.length > 0 && referenceElement !== null;

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: (next) => {
      if (!next) onDismiss();
    },
    elements: { reference: referenceElement ?? undefined },
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
      size({
        padding: 8,
        apply: ({ availableHeight, elements }) => {
          elements.floating.style.maxHeight = `${Math.max(96, Math.min(240, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Escape stays with the composer: there it means "close the picker, keep my
  // draft", and only means "cancel" when no picker is open.
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: 'listbox' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  if (!isOpen) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        className="nim-comment-mention-picker"
        data-testid="comment-mention-picker"
        id={listboxId}
        style={floatingStyles}
        {...getFloatingProps()}
      >
        {candidates.map((member, index) => (
          <div
            key={member.userId}
            id={mentionOptionId(listboxId, index)}
            role="option"
            aria-selected={index === activeIndex}
            className={
              index === activeIndex
                ? 'nim-comment-mention-option active'
                : 'nim-comment-mention-option'
            }
            // The field must keep focus through the click, or the caret
            // position the insertion depends on is gone by the time it runs.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActiveIndexChange(index)}
            onClick={() => onSelect(member)}
          >
            <span className="nim-comment-mention-name">{member.name}</span>
            {member.email && member.email !== member.name && (
              <span className="nim-comment-mention-email">{member.email}</span>
            )}
          </div>
        ))}
      </div>
    </FloatingPortal>
  );
}
