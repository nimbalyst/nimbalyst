/**
 * Custom Select component that supports rendering icons in options.
 * Uses @floating-ui/react + FloatingPortal to escape overflow:hidden/auto containers.
 */

import React, { useState } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal, size } from '@floating-ui/react';
import {MaterialSymbol} from "../../../ui";

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  color?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  required = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        apply({ rects, elements }) {
          Object.assign(elements.floating.style, {
            minWidth: `${rects.reference.width}px`,
          });
        },
      }),
    ],
  });

  const selectedOption = options.find(opt => opt.value === value);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  const handleToggle = () => setIsOpen(prev => !prev);

  const handleBlur = (e: React.FocusEvent) => {
    // Close if focus leaves both the trigger and the floating panel
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsOpen(false);
    }
  };

  return (
    <div className="custom-select relative inline-block w-full" onBlur={handleBlur}>
      <button
        ref={refs.setReference}
        type="button"
        className="custom-select-trigger flex items-center justify-between w-full py-1.5 px-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[13px] text-[var(--nim-text)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] focus:outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {selectedOption ? (
          <span className="custom-select-value flex items-center gap-1.5 flex-1">
            {selectedOption.icon && (
              <MaterialSymbol icon={selectedOption.icon} size={16} />
            )}
            <span>{selectedOption.label}</span>
          </span>
        ) : value ? (
          // The stored value isn't in the current options (an override removed/
          // renamed it, or a peer set it on a different schema). Render it neutrally
          // so the value stays visible and editable instead of silently vanishing.
          <span
            className="custom-select-value custom-select-value-unknown flex items-center gap-1.5 flex-1 text-[var(--nim-text-secondary)]"
            title={`Unrecognized option: ${value}`}
          >
            <MaterialSymbol icon="help_outline" size={16} />
            <span>{String(value)}</span>
          </span>
        ) : (
          <span className="custom-select-placeholder text-[var(--nim-text-faint)]">{placeholder}</span>
        )}
        <MaterialSymbol icon={isOpen ? 'expand_less' : 'expand_more'} size={16} />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="custom-select-dropdown bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded shadow-[0_4px_12px_rgba(0,0,0,0.15)] max-h-[300px] overflow-y-auto z-[9999]"
            style={floatingStyles}
            onMouseDown={(e) => e.preventDefault()} // prevent blur before click registers
          >
            {!required && (
              <button
                type="button"
                className="custom-select-option flex items-center gap-1.5 w-full py-2 px-2.5 border-none cursor-pointer text-[13px] text-[var(--nim-text)] text-left transition-colors duration-100 hover:bg-[var(--nim-bg-hover)]"
                onClick={() => handleSelect('')}
              >
                <span className="custom-select-option-label flex-1">None</span>
              </button>
            )}
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`custom-select-option flex items-center gap-1.5 w-full py-2 px-2.5 border-none cursor-pointer text-[13px] text-[var(--nim-text)] text-left transition-colors duration-100 hover:bg-[var(--nim-bg-hover)] ${option.value === value ? 'selected bg-[var(--nim-bg-tertiary)] font-medium' : ''}`}
                onClick={() => handleSelect(option.value)}
              >
                {option.icon && (
                  <MaterialSymbol icon={option.icon} size={16} />
                )}
                <span className="custom-select-option-label flex-1">{option.label}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
