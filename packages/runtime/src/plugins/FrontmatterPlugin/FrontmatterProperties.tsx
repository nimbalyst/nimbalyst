/**
 * A document's frontmatter as an editable list of properties, for a side
 * panel. Fields agents keep (`id`, `order`) sit behind a disclosure. Text
 * commits on blur or Enter, since each write re-parses the whole document.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  extractFrontmatterWithError,
  parseFields,
  updateFieldInFrontmatter,
  type InferredField,
} from './fieldUtils';
import { MaterialSymbol } from '../../ui/icons/MaterialSymbol';

/** Keys written for agents and tools rather than read by people. */
const SECONDARY_KEYS = new Set(['id', 'order']);

export interface FrontmatterPropertiesProps {
  /** Fresh document content. */
  getContent: () => string;
  /** Bumps when the content changes; the fields re-read on it. */
  contentVersion: number;
  /** Absent makes the list read-only. */
  onContentChange?: (newContent: string) => void;
}

const INPUT = 'frontmatter-property-input w-full min-w-0 rounded border border-transparent bg-nim px-2 py-1 text-[13px] text-nim font-[inherit] hover:border-nim focus:border-nim-primary focus:outline-none disabled:hover:border-transparent';

function dateParts(value: unknown): { date: string; time: string } {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const [date, time = ''] = value.toISOString().split('T');
    return { date, time };
  }
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T(.+))?$/.exec(value) : null;
  return match ? { date: match[1], time: match[2] ?? '' } : { date: '', time: '' };
}

/** A text input that keeps its draft until blur or Enter. */
function CommitInput({
  value,
  onCommit,
  multiline,
  disabled,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  disabled?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className={`${INPUT} resize-none`}
        rows={Math.min(5, Math.max(2, Math.ceil(draft.length / 34)))}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
      />
    );
  }
  return (
    <input
      {...rest}
      className={INPUT}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function FieldValue({ field, onChange, readOnly }: {
  field: InferredField;
  onChange: (value: unknown) => void;
  readOnly: boolean;
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          className="mt-1.5 h-4 w-4 cursor-pointer"
          checked={Boolean(field.value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'date': {
      const { date, time } = dateParts(field.value);
      return (
        <input
          type="date"
          className={INPUT}
          value={date}
          disabled={readOnly}
          onChange={(e) => onChange(time ? `${e.target.value}T${time}` : e.target.value)}
        />
      );
    }
    case 'number':
      return (
        <CommitInput
          type="number"
          step="any"
          value={field.value == null ? '' : String(field.value)}
          disabled={readOnly}
          onCommit={(next) => {
            const parsed = parseFloat(next);
            onChange(next === '' || isNaN(parsed) ? null : parsed);
          }}
        />
      );
    case 'tags':
    case 'array': {
      const items = Array.isArray(field.value) ? field.value.map(String) : [];
      return (
        <CommitInput
          value={items.join(', ')}
          placeholder="Comma-separated"
          disabled={readOnly}
          onCommit={(next) => onChange(next.split(',').map((v) => v.trim()).filter(Boolean))}
        />
      );
    }
    case 'link': {
      const href = String(field.value ?? '');
      return (
        <div className="flex items-center gap-1">
          <CommitInput type="url" value={href} placeholder="https://..." disabled={readOnly} onCommit={onChange} />
          {/^https?:\/\//.test(href) && (
            <a href={href} target="_blank" rel="noopener noreferrer" className="flex p-1 text-nim-muted hover:text-nim-primary" aria-label="Open link">
              <MaterialSymbol icon="open_in_new" size={14} />
            </a>
          )}
        </div>
      );
    }
    case 'string':
    default: {
      const text = String(field.value ?? '');
      return <CommitInput value={text} multiline={text.length > 32} disabled={readOnly} onCommit={onChange} />;
    }
  }
}

export function FrontmatterProperties({ getContent, contentVersion, onContentChange }: FrontmatterPropertiesProps) {
  const [fields, setFields] = useState<InferredField[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showSecondary, setShowSecondary] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const readFields = useCallback((content: string) => {
    const result = extractFrontmatterWithError(content);
    setParseError(result.hasFrontmatter && !result.success ? (result.error || 'Invalid frontmatter') : null);
    setFields(result.data ? parseFields(result.data) : []);
  }, []);
  useEffect(() => readFields(getContent()), [getContent, contentVersion, readFields]);

  const readOnly = !onContentChange;
  const setField = useCallback((key: string, value: unknown) => {
    if (!onContentChange) return;
    const next = updateFieldInFrontmatter(getContent(), key, value);
    onContentChange(next);
    // A host need not bump `contentVersion` for its own write.
    readFields(next);
  }, [getContent, onContentChange, readFields]);

  if (parseError) {
    return (
      <div className="frontmatter-properties-error flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs" role="alert">
        <MaterialSymbol icon="error" size={16} className="shrink-0 text-red-500" />
        <div className="min-w-0">
          <div className="font-semibold text-red-500">Invalid frontmatter</div>
          <div className="whitespace-pre-wrap break-words font-mono text-nim-muted">{parseError}</div>
        </div>
      </div>
    );
  }

  const primary = fields.filter((field) => !SECONDARY_KEYS.has(field.key));
  const secondary = fields.filter((field) => SECONDARY_KEYS.has(field.key));
  const renderRow = (field: InferredField) => (
    <div key={field.key} className="frontmatter-property grid grid-cols-[84px_1fr] items-start gap-2">
      <label className="truncate pt-1 text-[13px] text-nim-muted" title={field.key}>{field.key}</label>
      <FieldValue field={field} readOnly={readOnly} onChange={(value) => setField(field.key, value)} />
    </div>
  );

  const commitNewKey = (raw: string) => {
    const key = raw.trim();
    setAddingKey(null);
    if (key && !fields.some((field) => field.key === key)) setField(key, '');
  };

  return (
    <div className="frontmatter-properties flex flex-col gap-2">
      {fields.length === 0 && <div className="text-xs text-nim-faint">No properties</div>}
      {primary.map(renderRow)}
      {secondary.length > 0 && (
        <button
          type="button"
          className="frontmatter-properties-more flex items-center gap-1 border-none bg-transparent p-0 text-left text-xs text-nim-faint hover:text-nim"
          onClick={() => setShowSecondary((open) => !open)}
          aria-expanded={showSecondary}
        >
          <MaterialSymbol icon={showSecondary ? 'expand_more' : 'chevron_right'} size={14} />
          {showSecondary ? 'Fewer' : `${secondary.length} more: ${secondary.map((field) => field.key).join(', ')}`}
        </button>
      )}
      {showSecondary && secondary.map(renderRow)}
      {!readOnly && (addingKey === null ? (
        <button
          type="button"
          className="frontmatter-properties-add flex items-center gap-1 border-none bg-transparent p-0 text-left text-xs text-nim-faint hover:text-nim"
          onClick={() => setAddingKey('')}
        >
          <MaterialSymbol icon="add" size={14} />
          Add property
        </button>
      ) : (
        <input
          autoFocus
          className={INPUT}
          placeholder="Property name"
          value={addingKey}
          onChange={(e) => setAddingKey(e.target.value)}
          onBlur={(e) => commitNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitNewKey(e.currentTarget.value);
            if (e.key === 'Escape') setAddingKey(null);
          }}
        />
      ))}
    </div>
  );
}
