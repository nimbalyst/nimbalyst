/**
 * GenericFrontmatterHeader - Renders arbitrary YAML frontmatter as editable fields
 *
 * This component provides a generic UI for any frontmatter that isn't handled
 * by specialized providers (like TrackerDocumentHeader).
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { DocumentHeaderComponentProps } from '../TrackerPlugin/documentHeader/DocumentHeaderRegistry';
import {
  extractFrontmatterWithError,
  parseFields,
  updateFieldInFrontmatter,
  type InferredField,
} from './fieldUtils';
import { MaterialSymbol } from '../../ui/icons/MaterialSymbol';

export const GenericFrontmatterHeader: React.FC<DocumentHeaderComponentProps> = ({
  getContent,
  contentVersion,
  onContentChange,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [localFields, setLocalFields] = useState<InferredField[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [hasFrontmatter, setHasFrontmatter] = useState(false);

  // Parse frontmatter on mount and when content changes externally
  useEffect(() => {
    const content = getContent();
    const parseResult = extractFrontmatterWithError(content);
    setHasFrontmatter(parseResult.hasFrontmatter);
    setParseError(parseResult.success ? null : (parseResult.error || null));
    const fields = parseResult.data ? parseFields(parseResult.data) : [];
    setLocalFields(fields);
  }, [getContent, contentVersion]);

  const handleFieldChange = useCallback(
    (fieldKey: string, newValue: unknown) => {
      if (!onContentChange) return;

      // Get fresh content and update
      const currentContent = getContent();
      const updatedContent = updateFieldInFrontmatter(currentContent, fieldKey, newValue);
      onContentChange(updatedContent);
    },
    [getContent, onContentChange]
  );

  const renderTagsField = useCallback(
    (field: InferredField) => {
      const tags = Array.isArray(field.value) ? field.value : [];

      const handleRemoveTag = (index: number) => {
        const newTags = [...tags];
        newTags.splice(index, 1);
        handleFieldChange(field.key, newTags);
      };

      const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const input = e.currentTarget;
          const newTag = input.value.trim();
          if (newTag && !tags.includes(newTag)) {
            handleFieldChange(field.key, [...tags, newTag]);
            input.value = '';
          }
        }
      };

      return (
        <div key={field.key} className="frontmatter-field frontmatter-field-tags flex flex-col gap-1 min-w-[200px] flex-1 max-md:w-full">
          <label className="text-[11px] font-medium text-[var(--nim-text-muted)] uppercase tracking-wider">{field.key}</label>
          <div className="frontmatter-tags-container flex flex-wrap gap-1.5 items-center p-1 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] min-h-8 focus-within:border-[var(--nim-primary)] focus-within:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]">
            {tags.map((tag, index) => (
              <span key={index} className="frontmatter-tag inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--nim-bg-tertiary)] rounded-xl text-xs text-[var(--nim-text)]">
                {String(tag)}
                <button
                  className="frontmatter-tag-remove flex items-center justify-center bg-transparent border-none p-0.5 cursor-pointer text-[var(--nim-text-muted)] rounded-full transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                  onClick={() => handleRemoveTag(index)}
                  aria-label={`Remove ${tag}`}
                >
                  <MaterialSymbol icon="close" size={12} />
                </button>
              </span>
            ))}
            <input
              type="text"
              className="frontmatter-tag-input border-none bg-transparent px-1 py-0.5 text-xs min-w-20 flex-1 shadow-none outline-none placeholder:text-[var(--nim-text-faint)] placeholder:text-xs"
              placeholder="Add tag..."
              onKeyDown={handleAddTag}
            />
          </div>
        </div>
      );
    },
    [handleFieldChange]
  );

  // Common input styles for frontmatter fields
  const inputStyles = "px-2 py-1.5 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[13px] font-[inherit] transition-colors duration-200 focus:outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]";
  const labelStyles = "text-[11px] font-medium text-[var(--nim-text-muted)] uppercase tracking-wider";
  const fieldStyles = "frontmatter-field flex flex-col gap-1 min-w-[140px] flex-none max-md:w-full";

  const renderField = useCallback(
    (field: InferredField) => {
      const fieldId = `frontmatter-${field.key}`;

      switch (field.type) {
        case 'tags':
          return renderTagsField(field);

        case 'boolean':
          return (
            <div key={field.key} className="frontmatter-field frontmatter-field-checkbox flex flex-row items-center max-md:w-full">
              <label htmlFor={fieldId} className="flex items-center gap-1.5 normal-case tracking-normal text-[13px] cursor-pointer">
                <input
                  id={fieldId}
                  type="checkbox"
                  className="cursor-pointer w-4 h-4"
                  checked={Boolean(field.value)}
                  onChange={(e) => handleFieldChange(field.key, e.target.checked)}
                />
                {field.key}
              </label>
            </div>
          );

        case 'date':
          // Convert date to input format (YYYY-MM-DD)
          let dateValue = '';
          let originalTimeComponent = '';
          if (field.value instanceof Date) {
            // Handle Date object from js-yaml
            const d = field.value;
            if (!isNaN(d.getTime())) {
              const isoString = d.toISOString();
              dateValue = isoString.split('T')[0];
              // Preserve time component if it exists
              const timeMatch = isoString.match(/T(.+)$/);
              if (timeMatch) {
                originalTimeComponent = timeMatch[1];
              }
            }
          } else if (typeof field.value === 'string') {
            const match = field.value.match(/^(\d{4}-\d{2}-\d{2})(T.+)?$/);
            if (match) {
              dateValue = match[1];
              // Preserve time component if it exists
              if (match[2]) {
                originalTimeComponent = match[2].substring(1); // Remove 'T' prefix
              }
            }
          }
          return (
            <div key={field.key} className={fieldStyles}>
              <label htmlFor={fieldId} className={labelStyles}>{field.key}</label>
              <input
                id={fieldId}
                type="date"
                className={inputStyles}
                value={dateValue}
                onChange={(e) => {
                  // Preserve time component when updating date
                  const newDate = e.target.value;
                  const newValue = originalTimeComponent
                    ? `${newDate}T${originalTimeComponent}`
                    : newDate;
                  handleFieldChange(field.key, newValue);
                }}
              />
            </div>
          );

        case 'number':
          return (
            <div key={field.key} className={fieldStyles}>
              <label htmlFor={fieldId} className={labelStyles}>{field.key}</label>
              <input
                id={fieldId}
                type="number"
                step="any"
                className={inputStyles}
                value={field.value as number}
                onChange={(e) => {
                  const val = e.target.value;
                  // Handle empty string - don't convert to 0
                  if (val === '') {
                    handleFieldChange(field.key, null);
                  } else {
                    // Preserve decimal precision by using parseFloat
                    const numValue = parseFloat(val);
                    handleFieldChange(field.key, isNaN(numValue) ? null : numValue);
                  }
                }}
              />
            </div>
          );

        case 'link':
          // Validate URL to prevent XSS via javascript: protocol
          const isValidUrl = (url: string): boolean => {
            return url.startsWith('http://') || url.startsWith('https://');
          };
          const linkValue = String(field.value || '');
          const canRenderLink = linkValue && isValidUrl(linkValue);

          return (
            <div key={field.key} className="frontmatter-field frontmatter-field-link flex flex-col gap-1 min-w-[200px] flex-1 max-md:w-full">
              <label htmlFor={fieldId} className={labelStyles}>{field.key}</label>
              <div className="frontmatter-link-container flex items-center gap-1">
                <input
                  id={fieldId}
                  type="url"
                  className={`${inputStyles} flex-1`}
                  value={linkValue}
                  onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  placeholder="https://..."
                />
                {canRenderLink && (
                  <a
                    href={linkValue}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="frontmatter-link-open flex items-center justify-center p-1.5 text-[var(--nim-text-muted)] rounded transition-all duration-200 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-primary)]"
                    aria-label="Open link"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                  </a>
                )}
              </div>
            </div>
          );

        case 'array':
          // Non-tag arrays as comma-separated
          const arrayValue = Array.isArray(field.value) ? field.value.join(', ') : '';
          return (
            <div key={field.key} className={fieldStyles}>
              <label htmlFor={fieldId} className={labelStyles}>{field.key}</label>
              <input
                id={fieldId}
                type="text"
                className={inputStyles}
                value={arrayValue}
                onChange={(e) => {
                  const newValue = e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0);
                  handleFieldChange(field.key, newValue);
                }}
                placeholder="Comma-separated values"
              />
            </div>
          );

        case 'string':
        default:
          return (
            <div key={field.key} className={fieldStyles}>
              <label htmlFor={fieldId} className={labelStyles}>{field.key}</label>
              <input
                id={fieldId}
                type="text"
                className={inputStyles}
                value={String(field.value || '')}
                onChange={(e) => handleFieldChange(field.key, e.target.value)}
              />
            </div>
          );
      }
    },
    [handleFieldChange, renderTagsField]
  );

  // Show error banner if frontmatter exists but failed to parse
  if (hasFrontmatter && parseError) {
    return (
      <div className="frontmatter-header frontmatter-header-error bg-[var(--nim-bg-secondary)] p-3 shadow-sm relative z-[1]">
        <div className="frontmatter-error-banner flex items-start gap-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-md text-[var(--nim-text)]">
          <MaterialSymbol icon="error" size={20} className="text-red-500 shrink-0" />
          <div className="frontmatter-error-content flex flex-col gap-1 min-w-0">
            <span className="frontmatter-error-title font-semibold text-[13px] text-red-500">Invalid Frontmatter</span>
            <span className="frontmatter-error-message text-xs text-[var(--nim-text-muted)] font-mono whitespace-pre-wrap break-words">{parseError}</span>
          </div>
        </div>
      </div>
    );
  }

  if (localFields.length === 0) {
    return null;
  }

  if (isCollapsed) {
    return (
      <div className="frontmatter-header frontmatter-header-collapsed bg-[var(--nim-bg-secondary)] px-3 py-2 shadow-sm relative z-[1]">
        <button
          className="frontmatter-toggle bg-transparent border-none px-3 py-1.5 cursor-pointer rounded text-[var(--nim-text-muted)] flex items-center gap-2 transition-all duration-200 text-[13px] w-full hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
          onClick={() => setIsCollapsed(false)}
          aria-label="Expand metadata"
        >
          <MaterialSymbol icon="data_object" size={18} />
          <span>Document Metadata</span>
          <span className="frontmatter-field-count ml-auto text-[11px] opacity-70">{localFields.length} fields</span>
        </button>
      </div>
    );
  }

  return (
    <div className="frontmatter-header bg-[var(--nim-bg-secondary)] p-3 shadow-sm relative z-[1]">
      <div
        className="frontmatter-header-title flex justify-between items-center mb-3 px-2 py-1 -mx-2 -mt-1 rounded transition-colors duration-150 cursor-pointer hover:bg-[var(--nim-bg-hover)]"
        onClick={() => setIsCollapsed(true)}
      >
        <div className="frontmatter-title-left flex items-center gap-2 font-semibold text-[var(--nim-text)] text-sm">
          <MaterialSymbol icon="data_object" size={20} />
          <span>Document Metadata</span>
        </div>
        <MaterialSymbol icon="expand_less" size={18} className="frontmatter-collapse-icon text-[var(--nim-text-muted)]" />
      </div>

      <div className="frontmatter-content flex flex-col gap-3">
        <div className="frontmatter-fields flex flex-wrap gap-4 items-start max-md:flex-col">
          {localFields.map((field) => renderField(field))}
        </div>
      </div>
    </div>
  );
};

/**
 * Check if content should render the generic frontmatter header
 */
export function shouldRenderGenericFrontmatter(content: string, filePath: string): boolean {
  // Only render for markdown files - other file types (e.g., .astro) may use ---
  // delimiters for non-YAML purposes (like JS imports in Astro frontmatter)
  const lowerPath = filePath.toLowerCase();
  if (lowerPath && !lowerPath.endsWith('.md') && !lowerPath.endsWith('.mdx')) {
    return false;
  }

  const result = extractFrontmatterWithError(content);

  // No frontmatter at all
  if (!result.hasFrontmatter) {
    return false;
  }

  // Show error banner for invalid frontmatter
  if (!result.success) {
    return true;
  }

  // No data parsed
  if (!result.data) {
    return false;
  }

  // todo: this is an aweful hack and we  need a better solution.
  // Skip if it's a tracker document or automation (handled by specialized headers)
  if (result.data.planStatus || result.data.decisionStatus || result.data.trackerStatus || result.data.automationStatus) {
    return false;
  }

  // Check for at least one renderable field
  const fields = parseFields(result.data);
  return fields.length > 0;
}
