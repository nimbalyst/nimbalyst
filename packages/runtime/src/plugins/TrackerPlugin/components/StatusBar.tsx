/**
 * Status Bar component for full-document tracker items
 * Renders at the top of the editor based on frontmatter
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { TrackerDataModel, FieldDefinition } from '../models/TrackerDataModel';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { TrackerFieldEditor, formatDateTimeDisplay } from './TrackerFieldEditor';
import './StatusBarSlider.css';

export interface StatusBarProps {
  model: TrackerDataModel;
  data: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  onClose?: () => void;
  trackerItemLink?: {
    label: string;
    title: string;
    onOpen: () => void;
  };
}

export const StatusBar: React.FC<StatusBarProps> = ({ model, data, onChange, onClose, trackerItemLink }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [localData, setLocalData] = useState<Record<string, any>>(data);

  useEffect(() => {
    setLocalData(data);
  }, [data]);

  const handleFieldChange = useCallback((fieldName: string, value: any) => {
    const newData = { ...localData, [fieldName]: value };
    setLocalData(newData);
    onChange({ [fieldName]: value });
  }, [localData, onChange]);

  const renderField = useCallback((field: FieldDefinition, width: number | 'auto') => {
    const value = localData[field.name];

    const fieldStyle: React.CSSProperties = {
      width: width === 'auto' ? 'auto' : `${width}px`,
      flex: width === 'auto' ? '1' : '0 0 auto',
    };

    return (
      <div key={field.name} style={fieldStyle}>
        <TrackerFieldEditor
          field={field}
          value={value}
          onChange={(newValue) => handleFieldChange(field.name, newValue)}
        />
      </div>
    );
  }, [localData, handleFieldChange]);

  if (isCollapsed) {
    return (
      <div className="status-bar status-bar-collapsed bg-[var(--nim-bg-secondary)] py-2 px-3 shadow-[0_1px_3px_rgba(0,0,0,0.1)] relative z-[1]">
        <button
          className="status-bar-toggle bg-transparent border-none p-1.5 px-3 cursor-pointer rounded text-[var(--nim-text-muted)] flex items-center gap-1 transition-all duration-200 w-full justify-between text-[13px] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
          onClick={() => setIsCollapsed(false)}
          aria-label="Expand status bar"
        >
          <div className="flex items-center gap-2">
            <MaterialSymbol icon={model.icon} size={18} />
            <span>{model.displayName}</span>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className="status-bar bg-[var(--nim-bg-secondary)] p-3 shadow-[0_1px_3px_rgba(0,0,0,0.1)] relative z-[1]">
      <div
        className="status-bar-header flex justify-between items-center mb-3 p-1 px-2 -m-1 -mx-2 rounded transition-colors duration-150 cursor-pointer hover:bg-[var(--nim-bg-hover)]"
        onClick={() => setIsCollapsed(true)}
      >
        <div className="status-bar-title flex items-center gap-2 font-semibold text-[var(--nim-text)] text-sm">
          <MaterialSymbol icon={model.icon} size={20} />
          <span>{model.displayName}</span>
          {trackerItemLink && (
            <button
              type="button"
              className="status-bar-tracker-item-link inline-flex items-center gap-1 rounded-full border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--nim-text-muted)] transition-colors hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title={`Open tracker item: ${trackerItemLink.title}`}
              aria-label={`Open tracker item ${trackerItemLink.label}`}
              onClick={(event) => {
                event.stopPropagation();
                trackerItemLink.onOpen();
              }}
            >
              <MaterialSymbol icon="tag" size={13} />
              {trackerItemLink.label}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {localData.created && (() => {
            const { display, title } = formatDateTimeDisplay(localData.created);
            return (
              <span className="text-[11px] text-[var(--nim-text-faint)]" title={`Created: ${title}`}>
                Created {display}
              </span>
            );
          })()}
          {localData.updated && (() => {
            // Only show updated if it's meaningfully after created (avoids showing
            // "Updated Mar 17" when "Created Mar 18" because updated was stale in the frontmatter)
            if (localData.created) {
              const createdMs = new Date(localData.created).getTime();
              const updatedMs = new Date(localData.updated).getTime();
              if (updatedMs <= createdMs) return null;
            }
            const { display, title } = formatDateTimeDisplay(localData.updated);
            return (
              <span className="text-[11px] text-[var(--nim-text-faint)]" title={`Updated: ${title}`}>
                Updated {display}
              </span>
            );
          })()}
          {onClose && (
            <button
              className="status-bar-close-btn bg-transparent border-none p-1 cursor-pointer rounded text-[var(--nim-text-muted)] flex items-center gap-1 transition-all duration-200 relative z-[1] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label="Remove tracker"
            >
              <MaterialSymbol icon="close" size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="status-bar-content flex flex-col gap-3">
        {model.statusBarLayout ? (
          // Render based on configured layout
          model.statusBarLayout.map((rowConfig, rowIndex) => (
            <div key={rowIndex} className="status-bar-row flex gap-4 items-start flex-wrap">
              {rowConfig.row.map((fieldConfig) => {
                const field = model.fields.find(f => f.name === fieldConfig.field);
                if (!field) return null;
                return renderField(field, fieldConfig.width);
              })}
            </div>
          ))
        ) : (
          // Default layout: one row with all fields
          <div className="status-bar-row flex gap-4 items-start flex-wrap">
            {model.fields
              .filter(f => f.displayInline !== false)
              .map(field => renderField(field, 'auto'))}
          </div>
        )}
      </div>
    </div>
  );
};
