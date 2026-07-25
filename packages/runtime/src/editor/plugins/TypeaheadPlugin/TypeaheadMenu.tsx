/**
 * Enhanced TypeaheadMenu System
 *
 * Built from lessons learned analyzing Lexical's LexicalMenu implementation.
 * Key improvements over the original:
 *
 * 1. POSITIONING: Viewport-aware positioning through Floating UI, including
 *    collision handling and a document-level portal that escapes editor clipping
 *
 * 2. SCROLL HANDLING: Separates internal menu scrolling from external document scrolling
 *    to prevent the menu from closing when user scrolls within the menu options
 *
 * 3. ARCHITECTURE: Structured layout with dedicated header/footer areas and scrollable
 *    content, rather than the original's single render function approach
 *
 * 4. DYNAMIC SIZING: Automatically adapts menu height based on available viewport space
 *
 * 5. ENHANCED OPTIONS: Built-in support for keyboard shortcuts, descriptions, and
 *    flyout previews without requiring complex custom rendering
 */

import React, {ReactNode, useCallback, useEffect, useMemo, useRef, useState,} from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  type VirtualElement,
  useFloating,
} from '@floating-ui/react';
import {
  $getSelection,
  $isRangeSelection,
  createCommand,
  LexicalCommand,
  LexicalEditor,
  RangeSelection,
  TextNode,
} from 'lexical';

// ============================================================================
  // TYPES
  // ============================================================================

  export interface TypeaheadMenuOption {
    id: string;
    label: string;
    description?: string;
    /** Secondary text shown on the right side of the option (e.g., truncated path) */
    secondaryText?: string;
    shortcut?: string;
    icon?: ReactNode;
    preview?: ReactNode;
    keywords?: string[];
    onSelect: () => void;
    disabled?: boolean;
    type?: 'option' | 'header';
    section?: string; // New: automatically groups options by section
    hidden?: boolean; // Hide this option from the menu
    flag?: 'beta' | 'new' | 'experimental' | 'developer'; // Add visual flags to menu items
    /** Optional tooltip text shown on hover */
    tooltip?: string;
  }

  export interface TypeaheadMenuMatch {
    leadOffset: number;
    matchingString: string;
    replaceableString: string;
  }

  export interface TypeaheadMenuResolution {
    match?: TypeaheadMenuMatch;
    getRect: () => DOMRect;
  }

  export type TriggerFunction = (
    text: string,
    editor: LexicalEditor,
  ) => TypeaheadMenuMatch | null;


  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const PUNCTUATION = '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\-\\[\\]\\\\/!%\'"~=<>_:;';
  const VIEWPORT_PADDING = 10;

  // Commands for integration with Lexical's command system
  export const SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND: LexicalCommand<{
    index: number;
    option: TypeaheadMenuOption;
  }> = createCommand('SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND');

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /**
   * Enhanced trigger function factory - improved from Lexical's useBasicTypeaheadTriggerMatch
   * Provides better character validation and customizable length constraints
   */
  export function createBasicTriggerFunction(
    trigger: string,
    { minLength = 1, maxLength = 75 }: { minLength?: number; maxLength?: number } = {}
  ): TriggerFunction {
    return (text: string) => {
      const validChars = '[^' + trigger + PUNCTUATION + '\\s]';
      const regex = new RegExp(
        '(^|\\s|\\()(' +
          '[' +
          trigger +
          ']' +
          '((?:' +
          validChars +
          '){0,' +
          maxLength +
          '})' +
          ')$',
      );
      const match = regex.exec(text);
      if (match !== null) {
        const maybeLeadingWhitespace = match[1];
        const matchingString = match[3];
        if (matchingString.length >= minLength) {
          return {
            leadOffset: match.index + maybeLeadingWhitespace.length,
            matchingString,
            replaceableString: match[2],
          };
        }
      }
      return null;
    };
  }

  /**
   * Get text content up to cursor position
   * Learned from Lexical's getTextUpToAnchor but with better error handling
   */
  export function getTextUpToAnchor(selection: RangeSelection): string | null {
    const anchor = selection.anchor;
    if (anchor.type !== 'text') {
      return null;
    }
    const anchorNode = anchor.getNode();
    const anchorOffset = anchor.offset;
    return anchorNode.getTextContent().slice(0, anchorOffset);
  }

  /**
   * Split text node containing the query - enhanced from Lexical's $splitNodeContainingQuery
   * with better offset calculation and error handling
   */
  export function splitNodeContainingQuery(match: TypeaheadMenuMatch): TextNode | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
      return null;
    }
    const anchor = selection.anchor;
    if (anchor.type !== 'text') {
      return null;
    }
    const anchorNode = anchor.getNode();
    if (!anchorNode.isSimpleText()) {
      return null;
    }
    const selectionOffset = anchor.offset;
    const textContent = anchorNode.getTextContent().slice(0, selectionOffset);
    const characterOffset = match.replaceableString.length;
    const queryOffset = getFullMatchOffset(
      textContent,
      match.matchingString,
      characterOffset,
    );
    const startOffset = selectionOffset - queryOffset;
    if (startOffset < 0) {
      return null;
    }
    let newNode;
    if (startOffset === 0) {
      [newNode] = anchorNode.splitText(selectionOffset);
    } else {
      [, newNode] = anchorNode.splitText(startOffset, selectionOffset);
    }
    return newNode;
  }

  /**
   * Enhanced match offset calculation from Lexical's getFullMatchOffset
   */
  export function getFullMatchOffset(
    documentText: string,
    entryText: string,
    offset: number,
  ): number {
    let triggerOffset = offset;
    for (let i = triggerOffset; i <= entryText.length; i++) {
      if (documentText.slice(-i) === entryText.substring(0, i)) {
        triggerOffset = i;
      }
    }
    return triggerOffset;
  }

  // ============================================================================
  // MENU OPTION COMPONENT
  // ============================================================================

  export interface MenuOptionProps {
    option: TypeaheadMenuOption;
    isSelected: boolean;
    onClick: () => void;
    onMouseEnter: () => void;
    className?: string;
    selectedClassName?: string;
  }

  const MenuOption: React.FC<MenuOptionProps> = ({
    option,
    isSelected,
    onClick,
    onMouseEnter,
    className = '',
    selectedClassName = '',
  }) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (isSelected && ref.current) {
        // Find the scrollable container WITHIN the typeahead menu only
        // Stop at .typeahead-menu to avoid scrolling the document
        let scrollContainer: HTMLElement | null = ref.current.parentElement;
        while (scrollContainer) {
          // Stop if we've reached the menu boundary
          if (scrollContainer.classList.contains('typeahead-menu')) {
            scrollContainer = null;
            break;
          }
          const style = getComputedStyle(scrollContainer);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            break;
          }
          scrollContainer = scrollContainer.parentElement;
        }

        // Manually scroll the container instead of using scrollIntoView
        // scrollIntoView scrolls ALL ancestors, which can scroll the editor
        if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
          const optionRect = ref.current.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();

          if (optionRect.bottom > containerRect.bottom) {
            // Option is below visible area - scroll down
            scrollContainer.scrollTop += optionRect.bottom - containerRect.bottom;
          } else if (optionRect.top < containerRect.top) {
            // Option is above visible area - scroll up
            scrollContainer.scrollTop -= containerRect.top - optionRect.top;
          }
        }
      }
    }, [isSelected]);

    // Render header differently
    if (option.type === 'header') {
      return (
        <div
          ref={ref}
          className={`typeahead-menu-header ${className} px-3 py-2 bg-nim-tertiary text-xs font-semibold text-nim-muted uppercase tracking-wide m-0 pointer-events-none`}
          role="presentation"
        >
          {option.label}
        </div>
      );
    }

    // Use single-line layout when secondaryText is provided (no description shown)
    const useSingleLineLayout = !!option.secondaryText;

    return (
      <div
        ref={ref}
        className={`typeahead-menu-option ${className} ${isSelected ? selectedClassName : ''} px-2.5 py-1.5 cursor-pointer flex items-center justify-between rounded mx-1 my-0.5 text-[0.9rem] text-nim gap-2 ${option.disabled ? 'opacity-50 pointer-events-none' : ''} ${isSelected ? 'bg-nim-selected' : 'bg-transparent'}`}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        role="option"
        aria-selected={isSelected}
        title={option.tooltip}
      >
        <div className="flex items-center flex-1 min-w-0 overflow-hidden">
          {option.icon && (
            <span className="mr-2 shrink-0">{option.icon}</span>
          )}
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="font-medium flex items-center gap-1.5 leading-tight overflow-hidden text-ellipsis whitespace-nowrap">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {option.label}
              </span>
              {option.flag && (
                <span style={{
                  fontSize: '0.6rem',
                  fontWeight: 600,
                  color: option.flag === 'beta' ? '#ff6b35' : option.flag === 'new' ? '#00c851' : option.flag === 'developer' ? '#6f42c1' : '#ff4444',
                  backgroundColor: option.flag === 'beta' ? '#fff3f0' : option.flag === 'new' ? '#f0fff4' : option.flag === 'developer' ? '#f8f5ff' : '#fff0f0',
                  padding: '1px 4px',
                  borderRadius: '2px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.3px',
                  border: `1px solid ${option.flag === 'beta' ? '#ff6b35' : option.flag === 'new' ? '#00c851' : option.flag === 'developer' ? '#6f42c1' : '#ff4444'}`,
                  flexShrink: 0,
                }}>
                  {option.flag}
                </span>
              )}
            </div>
            {!useSingleLineLayout && option.description && (
              <div className="text-sm text-nim-muted mt-0.5">
                {option.description}
              </div>
            )}
          </div>
        </div>
        {/* Secondary text (e.g., truncated path) shown on the right */}
        {option.secondaryText && (
          <span className="text-[0.8rem] text-nim-faint shrink overflow-hidden text-ellipsis whitespace-nowrap max-w-[50%] text-right">
            {option.secondaryText}
          </span>
        )}
        {option.shortcut && (
          <span className="text-xs text-nim-faint bg-nim-tertiary px-1.5 py-0.5 rounded font-mono shrink-0">
            {option.shortcut}
          </span>
        )}
      </div>
    );
  };

  // ============================================================================
  // UTILITY FUNCTIONS FOR SECTIONS
  // ============================================================================

  /**
   * Groups options by their section property
   * @param options - Array of options with optional section property
   * @returns Object mapping section names to arrays of options
   */
  export function groupOptionsBySection(options: TypeaheadMenuOption[]): Record<string, TypeaheadMenuOption[]> {
    const groups: Record<string, TypeaheadMenuOption[]> = {};
    
    for (const option of options) {
      const section = option.section || '_default';
      if (!groups[section]) {
        groups[section] = [];
      }
      groups[section].push(option);
    }
    
    return groups;
  }

  /**
   * Filters options based on query, including section names in search
   * @param options - Array of options to filter
   * @param query - Search query
   * @param searchFields - Fields to search in options
   * @returns Filtered options
   */
  export function filterOptionsWithSections(
    options: TypeaheadMenuOption[], 
    query: string,
    searchFields: Array<keyof TypeaheadMenuOption> = ['label', 'description', 'keywords', 'section']
  ): TypeaheadMenuOption[] {
    // First filter out hidden options
    const visibleOptions = options.filter(option => !option.hidden);
    
    if (!query.trim()) {
      return visibleOptions;
    }

    const regex = new RegExp(query, 'i');
    
    return visibleOptions.filter(option => {
      return searchFields.some(field => {
        const value = option[field];
        if (Array.isArray(value)) {
          return value.some(item => regex.test(String(item)));
        }
        return value && regex.test(String(value));
      });
    });
  }

  // ============================================================================
  // MAIN MENU COMPONENT
  // ============================================================================

  export const TypeaheadMenuContent: React.FC<{
    resolution: TypeaheadMenuResolution;
    options: TypeaheadMenuOption[];
    selectedIndex: number | null;
    onSelectOption: (option: TypeaheadMenuOption) => void;
    onSetSelectedIndex: (index: number) => void;
    header?: ReactNode;
    footer?: ReactNode;
    maxHeight?: number;
    minWidth?: number;
    maxWidth?: number;
    className?: string;
    optionClassName?: string;
    selectedOptionClassName?: string;
    anchorElem?: HTMLElement | null;
  }> = ({
    resolution,
    options,
    selectedIndex,
    onSelectOption,
    onSetSelectedIndex,
    header,
    footer,
    maxHeight = 500,
    minWidth = 250,
    maxWidth = 400,
    className = '',
    optionClassName = '',
    selectedOptionClassName = '',
    anchorElem,
  }) => {
    const virtualReference = useMemo<VirtualElement>(() => ({
      getBoundingClientRect: resolution.getRect,
      contextElement: anchorElem ?? undefined,
    }), [anchorElem, resolution]);
    const { refs, floatingStyles, isPositioned } = useFloating({
      open: true,
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [
        offset(0),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ availableHeight, availableWidth, elements }) {
            const constrainedWidth = Math.max(0, availableWidth);
            Object.assign(elements.floating.style, {
              minWidth: `${Math.min(minWidth, constrainedWidth)}px`,
              maxWidth: `${Math.min(maxWidth, constrainedWidth)}px`,
              maxHeight: `${Math.max(0, Math.min(maxHeight, availableHeight))}px`,
            });
          },
        }),
      ],
      whileElementsMounted: autoUpdate,
    });
    useEffect(() => {
      refs.setPositionReference(virtualReference);
      return () => refs.setPositionReference(null);
    }, [refs, virtualReference]);
    // Track whether mouse interaction is enabled.
    // This prevents auto-selection when the menu opens under the cursor.
    const [mouseInteractionEnabled, setMouseInteractionEnabled] = useState(false);

    // Disable mouse interaction when menu opens, then enable after a brief delay
    // This prevents the initial mouseenter from selecting the wrong item
    useEffect(() => {
      setMouseInteractionEnabled(false);
      const timer = setTimeout(() => {
        setMouseInteractionEnabled(true);
      }, 100);
      return () => clearTimeout(timer);
    }, [resolution]);

    // Only allow hover selection after mouse interaction is enabled
    const handleOptionMouseEnter = useCallback((index: number) => {
      if (mouseInteractionEnabled) {
        onSetSelectedIndex(index);
      }
    }, [mouseInteractionEnabled, onSetSelectedIndex]);

    // Group options by section
    const groupedOptions = useMemo(() => {
      return groupOptionsBySection(options);
    }, [options]);

    // Get section names in order (with _default last)
    const sectionNames = useMemo(() => {
      const names = Object.keys(groupedOptions).filter(name => name !== '_default');
      names.sort(); // Alphabetical order
      if (groupedOptions._default) {
        names.push('_default');
      }
      return names;
    }, [groupedOptions]);

    // Get the option at the selected index
    const selectedOption = selectedIndex !== null ? options[selectedIndex] : null;

    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          className={`typeahead-menu ${className} bg-nim border border-nim rounded-md shadow-lg z-[1000] flex flex-col overflow-hidden ${!isPositioned ? 'invisible pointer-events-none' : ''}`}
          role={isPositioned ? 'listbox' : undefined}
          style={{
            ...floatingStyles,
            width: 'max-content',
          }}
          // Prevent menu from closing when clicking inside
          onMouseDown={isPositioned ? (e) => e.preventDefault() : undefined}
        >
          {header && (
            <div className="border-b border-nim px-2.5 py-1.5 shrink-0">
              {header}
            </div>
          )}

          <div
            className="flex-1 overflow-y-auto overflow-x-hidden py-0.5"
            // Critical: Stop propagation of scroll events to prevent menu closure
            onScroll={(e) => e.stopPropagation()}
          >
            {sectionNames.length > 1 || (sectionNames.length === 1 && sectionNames[0] !== '_default') ? (
              sectionNames.map(sectionName => {
                const sectionOptions = groupedOptions[sectionName];
                if (!sectionOptions || sectionOptions.length === 0) return null;

                return (
                  <div key={sectionName} className="typeahead-section">
                    {sectionName !== '_default' && (
                      <div className="typeahead-section-header px-2.5 py-1.5 bg-nim-tertiary text-[0.7rem] font-semibold text-nim-muted uppercase tracking-wide m-0 pointer-events-none">
                        {sectionName}
                      </div>
                    )}
                    {sectionOptions.map((option) => {
                      // Find this option's index in the flat array
                      const flatIndex = options.findIndex(opt => opt.id === option.id);

                      return (
                        <MenuOption
                          key={option.id}
                          option={option}
                          isSelected={selectedOption?.id === option.id}
                          onClick={() => option.type !== 'header' && onSelectOption(option)}
                          onMouseEnter={() => option.type !== 'header' && flatIndex >= 0 && handleOptionMouseEnter(flatIndex)}
                          className={optionClassName}
                          selectedClassName={selectedOptionClassName}
                        />
                      );
                    })}
                  </div>
                );
              })
            ) : (
              options.map((option, index) => (
                <MenuOption
                  key={option.id}
                  option={option}
                  isSelected={selectedIndex === index}
                  onClick={() => option.type !== 'header' && onSelectOption(option)}
                  onMouseEnter={() => option.type !== 'header' && handleOptionMouseEnter(index)}
                  className={optionClassName}
                  selectedClassName={selectedOptionClassName}
                />
              ))
            )}
            {options.length === 0 && (
              <div className="p-4 text-center text-nim-faint italic">
                No matches found
              </div>
            )}
          </div>

          {footer && (
            <div className="border-t border-nim px-2.5 py-1.5 shrink-0">
              {footer}
            </div>
          )}
        </div>
      </FloatingPortal>
    );
  };
