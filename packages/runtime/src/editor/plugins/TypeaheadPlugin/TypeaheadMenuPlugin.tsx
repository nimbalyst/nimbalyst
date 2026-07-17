import type { JSX } from 'react';
import { createPortal } from "react-dom";

import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW, COMMAND_PRIORITY_NORMAL,
  CommandListenerPriority,
  getDOMSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, KEY_TAB_COMMAND,
  TextNode
} from "lexical";
import {getTextUpToAnchor, splitNodeContainingQuery, TriggerFunction, TypeaheadMenuContent, TypeaheadMenuOption, TypeaheadMenuResolution} from "./TypeaheadMenu";
import {ReactNode, useCallback, useEffect, useMemo, useState} from "react";
import {useLexicalComposerContext} from "@lexical/react/LexicalComposerContext";
import {mergeRegister} from "@lexical/utils";
import React from "react";

// Re-export TypeaheadMenuOption for convenience
export type { TypeaheadMenuOption };

export interface TypeaheadMenuProps {
    // Core functionality
    options: TypeaheadMenuOption[];
    triggerFn: TriggerFunction;
    onQueryChange: (query: string | null) => void;
    onSelectOption: (
      option: TypeaheadMenuOption,
      textNode: TextNode | null,
      closeMenu: () => void,
      matchingString: string,
    ) => void;

    // Layout customization
    header?: ReactNode;
    footer?: ReactNode;
    maxHeight?: number;
    minWidth?: number;
    maxWidth?: number;
    anchorElem?: HTMLElement | null;

    // Behavior
    closeOnScroll?: boolean;
    shouldSplitNodeWithQuery?: boolean;
    commandPriority?: CommandListenerPriority;

    // Styling
    className?: string;
    optionClassName?: string;
    selectedOptionClassName?: string;

    // Events
    onOpen?: (resolution: TypeaheadMenuResolution) => void;
    onClose?: () => void;
  }

  export function TypeaheadMenuPlugin({
    options,
    triggerFn,
    onQueryChange,
    onSelectOption,
    header,
    footer,
    maxHeight,
    minWidth,
    maxWidth,
    anchorElem,
    closeOnScroll = false,
    shouldSplitNodeWithQuery = true,
    commandPriority = COMMAND_PRIORITY_NORMAL,
    className,
    optionClassName,
    selectedOptionClassName,
    onOpen,
    onClose,
  }: TypeaheadMenuProps): JSX.Element | null {
    const [editor] = useLexicalComposerContext();
    const [resolution, setResolution] = useState<TypeaheadMenuResolution | null>(null);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

    // Create visual order list - matches how TypeaheadMenuContent renders with sections
    const visualOrderOptions = useMemo(() => {
      // If no sections, return selectable options in original order
      const hasSections = options.some(opt => opt.section);
      if (!hasSections) {
        return options.filter(opt => opt.type !== 'header');
      }

      // Group by section
      const grouped: Record<string, TypeaheadMenuOption[]> = {};
      options.forEach(opt => {
        if (opt.type === 'header') return;
        const section = opt.section || '_default';
        if (!grouped[section]) grouped[section] = [];
        grouped[section].push(opt);
      });

      // Sort sections alphabetically, with _default last
      const sectionNames = Object.keys(grouped).filter(s => s !== '_default').sort();
      if (grouped._default) sectionNames.push('_default');

      // Flatten in visual order
      const result: TypeaheadMenuOption[] = [];
      sectionNames.forEach(section => {
        result.push(...grouped[section]);
      });
      return result;
    }, [options]);

    // Close menu
    const closeMenu = useCallback(() => {
      setResolution(null);
      setSelectedIndex(null);
      onClose?.();
    }, [onClose]);

    // Open menu
    const openMenu = useCallback((newResolution: TypeaheadMenuResolution) => {
      setResolution(newResolution);

      // Find first selectable option (not a header)
      const firstSelectableIndex = options.findIndex(option => option.type !== 'header');
      setSelectedIndex(firstSelectableIndex >= 0 ? firstSelectableIndex : 0);

      onOpen?.(newResolution);
    }, [onOpen, options]);

    // Select option handler
    const handleSelectOption = useCallback((option: TypeaheadMenuOption) => {
      if (option.disabled) return;

      editor.update(() => {
        const textNode = resolution?.match && shouldSplitNodeWithQuery
          ? splitNodeContainingQuery(resolution.match)
          : null;

        textNode?.remove();

        onSelectOption(
          option,
          textNode,
          closeMenu,
          resolution?.match?.matchingString || '',
        );
      });
    }, [editor, resolution, shouldSplitNodeWithQuery, onSelectOption, closeMenu]);

    // Keyboard navigation - uses visual order
    useEffect(() => {
      if (!resolution) return;

      // Helper to find next option in visual order and map back to flat index
      const findNextVisualIndex = (direction: 'up' | 'down'): number | null => {
        if (visualOrderOptions.length === 0) return null;

        // Find current option in visual order
        const currentOption = selectedIndex !== null ? options[selectedIndex] : null;
        const currentVisualIndex = currentOption
          ? visualOrderOptions.findIndex(opt => opt.id === currentOption.id)
          : -1;

        // Navigate in visual order
        const increment = direction === 'down' ? 1 : -1;
        let newVisualIndex = currentVisualIndex + increment;

        // Stop at boundaries instead of wrapping
        if (newVisualIndex < 0 || newVisualIndex >= visualOrderOptions.length) {
          return null;
        }

        // Get the option at new visual position
        const newOption = visualOrderOptions[newVisualIndex];

        // Map back to flat array index
        return options.findIndex(opt => opt.id === newOption.id);
      };

      return mergeRegister(
        editor.registerCommand(
          KEY_ARROW_DOWN_COMMAND,
          (event: KeyboardEvent) => {
            const newIndex = findNextVisualIndex('down');
            if (newIndex !== null) {
              setSelectedIndex(newIndex);
            }
            // Always block the event to keep menu open
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          },
          commandPriority,
        ),

        editor.registerCommand(
          KEY_ARROW_UP_COMMAND,
          (event: KeyboardEvent) => {
            const newIndex = findNextVisualIndex('up');
            if (newIndex !== null) {
              setSelectedIndex(newIndex);
            }
            // Always block the event to keep menu open
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          },
          commandPriority,
        ),

        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event: KeyboardEvent | null) => {
            if (selectedIndex !== null && options[selectedIndex] && options[selectedIndex].type !== 'header') {
              handleSelectOption(options[selectedIndex]);
              event?.preventDefault();
              event?.stopImmediatePropagation();
              return true;
            }
            return false;
          },
          commandPriority,
        ),

        editor.registerCommand(
          KEY_TAB_COMMAND,
          (event: KeyboardEvent) => {
            if (selectedIndex !== null && options[selectedIndex] && options[selectedIndex].type !== 'header') {
              handleSelectOption(options[selectedIndex]);
              event.preventDefault();
              event.stopImmediatePropagation();
              return true;
            }
            return false;
          },
          commandPriority,
        ),

        editor.registerCommand(
          KEY_ESCAPE_COMMAND,
          (event: KeyboardEvent) => {
            closeMenu();
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          },
          commandPriority,
        ),
      );
    }, [
      resolution,
      options,
      visualOrderOptions,
      selectedIndex,
      handleSelectOption,
      closeMenu,
      editor,
      commandPriority,
    ]);

    // Monitor editor state for trigger detection
    useEffect(() => {
      const removeUpdateListener = editor.registerUpdateListener(() => {
        editor.getEditorState().read(() => {
          if (!editor.isEditable()) {
            closeMenu();
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            closeMenu();
            return;
          }

          const text = getTextUpToAnchor(selection);
          if (!text) {
            closeMenu();
            return;
          }

          const match = triggerFn(text, editor);
          onQueryChange(match?.matchingString || null);

          if (match) {
            const editorWindow = editor._window || window;
            const range = editorWindow.document.createRange();
            const domSelection = getDOMSelection(editorWindow);

            if (domSelection?.isCollapsed && domSelection.anchorNode) {
              try {
                range.setStart(domSelection.anchorNode, match.leadOffset);
                range.setEnd(domSelection.anchorNode, domSelection.anchorOffset || 0);

                openMenu({
                  match,
                  getRect: () => range.getBoundingClientRect(),
                });
                return;
              } catch (error) {
                // Range setting failed, fall through to close menu
              }
            }
          }

          closeMenu();
        });
      });

      return removeUpdateListener;
    }, [editor, triggerFn, onQueryChange, closeMenu, openMenu]);

    // Handle editor editable state changes
    useEffect(() => {
      return editor.registerEditableListener((isEditable) => {
        if (!isEditable) {
          closeMenu();
        }
      });
    }, [editor, closeMenu]);

    // Enhanced scroll handling - only close on external scroll if configured
    useEffect(() => {
      if (!resolution || !closeOnScroll) return;

      const handleScroll = (event: Event) => {
        // Don't close if the scroll is happening within our menu
        const target = event.target as HTMLElement;
        if (target?.closest('.typeahead-menu')) {
          return;
        }
        closeMenu();
      };

      document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
      return () => document.removeEventListener('scroll', handleScroll, true);
    }, [resolution, closeOnScroll, closeMenu]);

    // Return JSX directly instead of an object - AFTER all hooks have been called
    if (!resolution) return null;

    return createPortal(
      <TypeaheadMenuContent
        resolution={resolution}
        options={options}
        selectedIndex={selectedIndex}
        onSelectOption={handleSelectOption}
        onSetSelectedIndex={setSelectedIndex}
        header={header}
        footer={footer}
        maxHeight={maxHeight}
        minWidth={minWidth}
        maxWidth={maxWidth}
        className={className}
        optionClassName={optionClassName}
        selectedOptionClassName={selectedOptionClassName}
        anchorElem={anchorElem}
      />,
      anchorElem ?? document.body
    );
  }
