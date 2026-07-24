/**
 * TrackerFieldEditor - Reusable field editor for tracker data model fields.
 * Renders the appropriate input control based on FieldDefinition type.
 * Used by both StatusBar (document headers) and TrackerItemDetail (edit panel).
 */

import React, { useState, useRef, useEffect } from 'react';
import type { FieldDefinition, UrlFieldValue } from '../models/TrackerDataModel';
import { CustomSelect } from './CustomSelect';
import { UserAvatar } from './UserAvatar';
import { getInitials, stringToColor } from './trackerColumns';
import { RelationshipFieldEditor, type RelationshipCandidate } from './RelationshipFieldEditor';

/** Team member info for user picker dropdown */
export interface TeamMemberOption {
  email: string;
  name?: string;
}

export interface TrackerFieldEditorProps {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
  /** 'vertical' = label on top (default), 'horizontal' = label on left */
  layout?: 'horizontal' | 'vertical';
  /** Team members for user picker dropdowns (when available) */
  teamMembers?: TeamMemberOption[];
  /** Candidate target items for relationship-field typeahead (when available). */
  relationshipCandidates?: RelationshipCandidate[];
  /** Open a related tracker item (relationship pill click). */
  onOpenRelationship?: (itemId: string) => void;
}

const labelClasses = "text-[11px] font-medium text-[var(--nim-text-muted)] uppercase tracking-[0.5px]";
const inputClasses = "py-1.5 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[13px] font-inherit transition-colors duration-200 focus:outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]";

/**
 * Format a display label from a camelCase field name.
 * e.g. "publishDate" -> "Publish Date", "storyPoints" -> "Story Points"
 */
function formatFieldLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

/**
 * Format a datetime value for read-only display.
 * Shows relative date (e.g. "Mar 14, 2026") with full timestamp on hover.
 */
export function formatDateTimeDisplay(value: any): { display: string; title: string } {
  if (!value) return { display: '--', title: '' };

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else {
    date = new Date(String(value));
  }

  if (isNaN(date.getTime())) return { display: String(value), title: '' };

  const display = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const title = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return { display, title };
}

// User field rendering is now driven by the schema's field type declaration (type: 'user')
// rather than a hardcoded name list.

export const TrackerFieldEditor: React.FC<TrackerFieldEditorProps> = ({
  field,
  value,
  onChange,
  layout = 'vertical',
  teamMembers,
  relationshipCandidates,
  onOpenRelationship,
}) => {
  const fieldId = `field-${field.name}`;
  const label = formatFieldLabel(field.name);
  // Field type is authoritative from the schema definition
  const effectiveType = field.type;

  const wrapperClasses = layout === 'horizontal'
    ? "flex flex-row items-center gap-2 min-w-[120px]"
    : "flex flex-col gap-1 min-w-[120px]";

  // Read-only datetime fields show a formatted display instead of an input
  if (field.readOnly && (effectiveType === 'datetime' || effectiveType === 'date')) {
    const { display, title } = formatDateTimeDisplay(value);
    return (
      <div className={wrapperClasses}>
        <label className={labelClasses}>{label}</label>
        <span
          className="text-[13px] text-[var(--nim-text-muted)] py-1.5"
          title={title}
        >
          {display}
        </span>
      </div>
    );
  }

  switch (effectiveType) {
    case 'select':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <CustomSelect
            value={value || field.default || ''}
            options={field.options || []}
            onChange={onChange}
            required={field.required}
          />
        </div>
      );

    case 'number': {
      const useSlider = field.min !== undefined && field.max !== undefined;

      if (useSlider) {
        return (
          <div className={`${wrapperClasses} status-bar-field-slider`}>
            <div className="slider-header flex justify-between items-center gap-2 mb-1 w-full">
              <label htmlFor={fieldId} className={`${labelClasses} flex-1 mb-0`}>{label}</label>
              <input
                type="number"
                className="w-[60px] py-1 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[13px] font-semibold font-inherit text-center transition-colors duration-200 focus:outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
                value={value ?? field.default ?? field.min}
                min={field.min}
                max={field.max}
                onChange={(e) => {
                  const newValue = Number(e.target.value);
                  if (!isNaN(newValue)) {
                    onChange(newValue);
                  }
                }}
              />
            </div>
            <input
              id={fieldId}
              type="range"
              className="w-full"
              value={value ?? field.default ?? field.min}
              min={field.min}
              max={field.max}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          </div>
        );
      }

      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <input
            id={fieldId}
            type="number"
            className={inputClasses}
            value={value ?? field.default ?? ''}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      );
    }

    case 'date':
    case 'datetime': {
      let dateValue = value || '';
      if (value instanceof Date && !isNaN(value.getTime())) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        dateValue = `${y}-${m}-${d}`;
      }
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <input
            id={fieldId}
            type="date"
            className={inputClasses}
            value={dateValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    }

    case 'text':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <textarea
            id={fieldId}
            className={`${inputClasses} min-h-[80px] resize-y`}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.required ? 'Required' : 'Optional'}
          />
        </div>
      );

    case 'user':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <UserFieldInput
            value={value || ''}
            onChange={onChange}
            placeholder={field.required ? 'Required' : 'Optional'}
            teamMembers={teamMembers}
          />
        </div>
      );

    case 'string':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <input
            id={fieldId}
            type="text"
            className={inputClasses}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.required ? 'Required' : 'Optional'}
          />
        </div>
      );

    case 'array':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <TagChipsInput
            value={Array.isArray(value) ? value : []}
            onChange={onChange}
          />
        </div>
      );

    case 'url':
      return (
        <div className={wrapperClasses}>
          <label htmlFor={fieldId} className={labelClasses}>{label}</label>
          <UrlFieldInput
            id={fieldId}
            value={value}
            onChange={onChange}
            placeholder={field.required ? 'Required' : 'https://...'}
          />
        </div>
      );

    case 'boolean':
      return (
        <div className={layout === 'horizontal' ? "flex flex-row items-center gap-2 min-w-[120px]" : "flex flex-row items-center min-w-[120px]"}>
          <label htmlFor={fieldId} className="flex items-center gap-1.5 normal-case tracking-normal text-[13px] cursor-pointer text-[var(--nim-text)]">
            <input
              id={fieldId}
              type="checkbox"
              className="cursor-pointer w-4 h-4"
              checked={value || false}
              onChange={(e) => onChange(e.target.checked)}
            />
            {label}
          </label>
        </div>
      );

    case 'relationship':
    case 'reference':
      return (
        <div className={wrapperClasses}>
          <label className={labelClasses}>{label}</label>
          <RelationshipFieldEditor
            field={field}
            value={value}
            onChange={onChange}
            candidates={relationshipCandidates}
            onOpenItem={onOpenRelationship}
            readOnly={field.readOnly}
          />
        </div>
      );

    default:
      return null;
  }
};

/**
 * Tag chips input with add/remove for array fields (labels, tags).
 */
const TagChipsInput: React.FC<{
  value: string[];
  onChange: (value: string[]) => void;
}> = ({ value, onChange }) => {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputValue('');
  };

  const handleRemove = (tag: string) => {
    onChange(value.filter(v => v !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAdd();
    } else if (e.key === 'Backspace' && !inputValue && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1 p-1.5 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] min-h-[32px] cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] text-[11px]"
        >
          {tag}
          <button
            className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] ml-0.5"
            onClick={(e) => { e.stopPropagation(); handleRemove(tag); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>close</span>
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 min-w-[60px] bg-transparent border-none text-[var(--nim-text)] text-[12px] outline-none p-0"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleAdd}
        placeholder={value.length === 0 ? 'Add tag...' : ''}
      />
    </div>
  );
};

/**
 * User field input with avatar display and optional team member dropdown.
 * Shows avatar + text input. When team members are available, clicking shows a dropdown.
 */
const UserFieldInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  teamMembers?: TeamMemberOption[];
}> = ({ value, onChange, placeholder, teamMembers }) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [filterText, setFilterText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  const displayName = value || '';
  const hasMembers = teamMembers && teamMembers.length > 0;

  const filteredMembers = hasMembers
    ? teamMembers.filter(m => {
        const q = filterText.toLowerCase();
        return (m.name?.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
      })
    : [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        {displayName && <UserAvatar identity={displayName} size={18} />}
        <input
          type="text"
          className={`${inputClasses} flex-1 min-w-0`}
          value={displayName}
          onChange={(e) => {
            onChange(e.target.value);
            setFilterText(e.target.value);
            if (hasMembers && !showDropdown) setShowDropdown(true);
          }}
          onFocus={() => { if (hasMembers) setShowDropdown(true); }}
          onMouseDown={(e) => {
            // Prevent focus theft by stopping propagation
            e.stopPropagation();
            if (hasMembers) setShowDropdown(true);
          }}
          placeholder={placeholder}
        />
        {displayName && (
          <button
            className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] p-0.5"
            onClick={() => { onChange(''); setFilterText(''); }}
            title="Clear"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        )}
      </div>
      {showDropdown && filteredMembers.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-1 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg z-30 max-h-[200px] overflow-auto py-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {filteredMembers.map(member => (
            <button
              key={member.email}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--nim-bg-hover)] text-xs text-[var(--nim-text)]"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange(member.email);
                setShowDropdown(false);
                setFilterText('');
              }}
            >
              <UserAvatar identity={member.name || member.email} size={18} />
              <div className="flex flex-col min-w-0">
                {member.name && <span className="truncate">{member.name}</span>}
                <span className="text-[var(--nim-text-faint)] truncate">{member.email}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Normalize a stored url field value to { url, label }. Legacy items may have
 * stored a plain string, so we accept both shapes.
 */
function normalizeUrlValue(value: unknown): UrlFieldValue {
  if (typeof value === 'string') return { url: value };
  if (value && typeof value === 'object') {
    const v = value as Partial<UrlFieldValue>;
    return { url: typeof v.url === 'string' ? v.url : '', label: v.label };
  }
  return { url: '' };
}

/**
 * URL field input: URL on top, optional display label below, with an "open"
 * affordance to test the link in the user's default browser.
 */
const UrlFieldInput: React.FC<{
  id: string;
  value: unknown;
  onChange: (value: UrlFieldValue | undefined) => void;
  placeholder?: string;
}> = ({ id, value, onChange, placeholder }) => {
  const normalized = normalizeUrlValue(value);

  const update = (next: UrlFieldValue) => {
    // Persist empty values as undefined so optional URL fields don't store empty objects.
    if (!next.url && !next.label) {
      onChange(undefined);
      return;
    }
    onChange({ url: next.url, label: next.label || undefined });
  };

  const canOpen = (() => {
    if (!normalized.url) return false;
    try { new URL(normalized.url); return true; } catch { return false; }
  })();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="url"
          className={`${inputClasses} flex-1 min-w-0`}
          value={normalized.url}
          onChange={(e) => update({ ...normalized, url: e.target.value })}
          placeholder={placeholder}
          spellCheck={false}
        />
        {canOpen && (
          <a
            href={normalized.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-text-faint)] hover:text-[var(--nim-primary)] p-1"
            title="Open link"
          >
            <span className="material-symbols-outlined text-sm">open_in_new</span>
          </a>
        )}
      </div>
      <input
        type="text"
        className={`${inputClasses} text-[12px]`}
        value={normalized.label || ''}
        onChange={(e) => update({ ...normalized, label: e.target.value })}
        placeholder="Display label (optional)"
      />
    </div>
  );
};
