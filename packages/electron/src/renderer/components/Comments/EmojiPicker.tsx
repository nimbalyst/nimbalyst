import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloating, autoUpdate, flip, offset, shift, type ReferenceElement } from '@floating-ui/react';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { EMOJI_CATALOG, QUICK_REACTIONS, emojiGlyphOrShortcode, searchEmoji } from './emojiCatalog';
import type { EmojiEntry } from './emojiCatalog';

const GROUP_LABELS: Record<EmojiEntry['group'], string> = {
  reactions: 'Frequently used',
  people: 'People',
  objects: 'Objects',
  symbols: 'Symbols',
};

/**
 * Shortcode-first emoji picker for the reaction affordance. Selection yields a
 * shortcode, not a glyph, because that is what both `ReactionAggregate.emoji`
 * and the `:shortcode:` body token store.
 *
 * Open state can be lifted (`open` + `onOpenChange`) so a call site can keep a
 * hover-revealed container visible while the popover is up. The picker
 * autofocuses its search field inside a portal, so `focus-within` on the
 * container -- which is what holds the row action menu open -- cannot see it.
 */
export function EmojiPicker({
  trigger,
  onSelect,
  quickRow = true,
  placement = 'top-start',
  testId = 'emoji-picker',
  open,
  onOpenChange,
}: {
  trigger: (props: { ref: (node: HTMLElement | null) => void; onClick: () => void; open: boolean } & Record<string, unknown>) => React.ReactNode;
  onSelect: (shortcode: string) => void;
  quickRow?: boolean;
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  testId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const menu = useFloatingMenu({ placement, open, onOpenChange });
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    if (query.trim().length > 0) {
      return [{ group: 'reactions' as const, label: 'Results', entries: searchEmoji(query, 24) }];
    }
    const order: EmojiEntry['group'][] = ['reactions', 'people', 'objects', 'symbols'];
    return order.map((group) => ({
      group,
      label: GROUP_LABELS[group],
      entries: EMOJI_CATALOG.filter((entry) => entry.group === group),
    }));
  }, [query]);

  const choose = (shortcode: string) => {
    onSelect(shortcode);
    setQuery('');
    menu.setIsOpen(false);
  };

  return (
    <>
      {trigger({
        ref: menu.refs.setReference,
        onClick: () => menu.setIsOpen(!menu.isOpen),
        open: menu.isOpen,
        ...menu.getReferenceProps(),
      })}

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            data-testid={testId}
            className="emoji-picker z-[10000] w-[268px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-2 shadow-[0_6px_18px_rgba(0,0,0,0.22)]"
          >
            {quickRow && query.trim().length === 0 && (
              <div className="emoji-picker-quick mb-2 flex items-center gap-1 border-b border-[var(--nim-border)] pb-2">
                {QUICK_REACTIONS.map((shortcode) => (
                  <button
                    key={shortcode}
                    type="button"
                    data-testid={`emoji-quick-${shortcode}`}
                    title={`:${shortcode}:`}
                    aria-label={shortcode}
                    className="emoji-picker-quick-item rounded p-1 text-[16px] leading-none hover:bg-[var(--nim-bg-hover)]"
                    onClick={() => choose(shortcode)}
                  >
                    {emojiGlyphOrShortcode(shortcode)}
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              value={query}
              autoFocus
              placeholder="Search emoji"
              data-testid="emoji-picker-search"
              aria-label="Search emoji"
              onChange={(event) => setQuery(event.target.value)}
              className="emoji-picker-search mb-2 w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1 text-[12px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-border-focus)]"
            />

            {groups.every((group) => group.entries.length === 0) ? (
              <p className="emoji-picker-empty m-0 px-1 py-2 text-[12px] text-[var(--nim-text-faint)]">
                No emoji match that.
              </p>
            ) : (
              groups
                .filter((group) => group.entries.length > 0)
                .map((group) => (
                  <div key={group.group} className="emoji-picker-group">
                    <div className="emoji-picker-group-label px-1 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
                      {group.label}
                    </div>
                    <div className="emoji-picker-grid grid grid-cols-8 gap-0.5">
                      {group.entries.map((entry) => (
                        <button
                          key={entry.shortcode}
                          type="button"
                          data-testid={`emoji-option-${entry.shortcode}`}
                          title={`:${entry.shortcode}:`}
                          aria-label={entry.shortcode}
                          className="emoji-picker-item rounded p-1 text-[15px] leading-none hover:bg-[var(--nim-bg-hover)]"
                          onClick={() => choose(entry.shortcode)}
                        >
                          {entry.glyph}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/**
 * `:shortcode:` autocomplete, anchored at the caret.
 *
 * Separate from `EmojiPicker` on purpose: the picker is a deliberate browse
 * ("what reactions exist"), this is an inline completion of something already
 * being typed, and merging them would make the browse surface pop open in the
 * middle of a sentence.
 */
export function EmojiAutocomplete({
  anchorRect,
  entries,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: {
  anchorRect: DOMRect | null;
  entries: EmojiEntry[];
  activeIndex: number;
  onSelect: (entry: EmojiEntry) => void;
  onActiveIndexChange: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualReference = useMemo<ReferenceElement>(
    () => ({ getBoundingClientRect: () => anchorRect ?? new DOMRect(0, 0, 0, 0) }),
    [anchorRect],
  );
  const { refs, floatingStyles } = useFloating({
    placement: 'top-start',
    // Fixed matches the rest of the app's floating surfaces and survives a
    // scrolling ancestor; autoUpdate keeps it pinned while the timeline moves.
    strategy: 'fixed',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Virtual references go through setPositionReference, not `elements`.
  useLayoutEffect(() => {
    refs.setPositionReference(virtualReference);
  }, [refs, virtualReference]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (entries.length === 0) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        role="listbox"
        aria-label="Emoji suggestions"
        data-testid="emoji-autocomplete"
        className="emoji-autocomplete z-[10000] max-h-[220px] w-[240px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_6px_18px_rgba(0,0,0,0.22)]"
      >
        <div ref={listRef}>
          {entries.map((entry, index) => (
            <button
              key={entry.shortcode}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex ? 'true' : 'false'}
              data-testid={`emoji-suggestion-${entry.shortcode}`}
              className={`emoji-autocomplete-option flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-[var(--nim-text)] ${
                index === activeIndex ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
              }`}
              onMouseEnter={() => onActiveIndexChange(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(entry)}
            >
              <span className="text-[15px] leading-none">{entry.glyph}</span>
              <span className="truncate">:{entry.shortcode}:</span>
            </button>
          ))}
        </div>
      </div>
    </FloatingPortal>
  );
}

/**
 * Icon trigger for the picker, styled to match `CommentActionMenu`'s trigger --
 * the two sit side by side in the comment row's hover actions.
 */
export function EmojiTriggerButton({
  label,
  testId,
  triggerProps,
}: {
  label: string;
  testId: string;
  triggerProps: { ref: (node: HTMLElement | null) => void; onClick: () => void; open: boolean } & Record<string, unknown>;
}) {
  const { ref, onClick, open, ...rest } = triggerProps;
  return (
    <button
      ref={ref as unknown as React.Ref<HTMLButtonElement>}
      {...rest}
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={onClick}
      className={`emoji-trigger flex size-6 items-center justify-center rounded border text-[var(--nim-text-muted)] ${
        open
          ? 'border-[var(--nim-primary)] bg-[var(--nim-bg-hover)]'
          : 'border-transparent hover:border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]'
      }`}
    >
      <MaterialSymbol icon="add_reaction" size={14} />
    </button>
  );
}
