/**
 * Tracker header for full-document tracker items (a plan, a decision, ...).
 *
 * The document's frontmatter fields render as the same compact chip row every
 * other tracker surface uses, so a plan's status reads and edits identically
 * whether you're in the document or in Tracker Mode. The panel stays
 * collapsible, and the values still round-trip through frontmatter: `onChange`
 * receives one field at a time exactly as it did when this was a form.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TeamMemberOption } from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { TrackerFieldPills } from './TrackerFieldPills';
import { useTrackerChipFieldSections } from './trackerChipFields';
import { unwrapLabelFieldValues, useTrackerLabelFields, wrapLabelFieldValue } from './trackerLabelFields';
import './StatusBarSlider.css';
import './StatusBar.css';

export interface StatusBarProps {
  /** Show labels for values without a distinguishing option icon. */
  labelFields?: boolean;
  model: TrackerDataModel;
  data: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  onClose?: () => void;
  trackerItemLink?: {
    label: string;
    title: string;
    onOpen: () => void;
  };
  teamMembers?: TeamMemberOption[];
  relationshipCandidates?: Map<string, RelationshipCandidate[]>;
  onOpenItem?: (itemId: string) => void;
  onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  labelFields = false,
  model,
  data,
  onChange,
  onClose,
  trackerItemLink,
  teamMembers,
  relationshipCandidates,
  onOpenItem,
  onCreateCollection,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [localData, setLocalData] = useState<Record<string, any>>(data);
  // Label properties follow the type's fields; qualified values are edited bare.
  const labelLayout = useTrackerLabelFields(model.type, localData);
  const { chipFields } = useTrackerChipFieldSections(model.type, undefined, labelLayout.fields);
  const chipValues = useMemo(() => unwrapLabelFieldValues(labelLayout.fields, localData), [labelLayout.fields, localData]);

  useEffect(() => {
    setLocalData(data);
  }, [data]);

  // Read through a ref: a save callback that changed identity on every edit
  // would make each chip flush its pending text save early.
  const localDataRef = useRef(localData);
  localDataRef.current = localData;
  const handleFieldChange = useCallback((fieldName: string, value: any) => {
    const field = labelLayout.fields.find((candidate) => candidate.name === fieldName);
    const stored = field ? wrapLabelFieldValue(field, value, localDataRef.current[fieldName]) : value;
    setLocalData((current) => ({ ...current, [fieldName]: stored }));
    onChange({ [fieldName]: stored });
  }, [labelLayout.fields, onChange]);

  const toggle = useCallback(() => setIsCollapsed((collapsed) => !collapsed), []);

  return (
    <div
      className={`status-bar bg-[var(--nim-bg-secondary)] px-3 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.1)] relative z-[1] ${isCollapsed ? 'status-bar-collapsed' : ''}`}
      data-testid="tracker-status-bar"
    >
      {/*
        A div, not a button: the issue-key chip is itself a button and cannot
        nest inside one. Keyboard users still get the same toggle.
      */}
      <div
        className="status-bar-header flex justify-between items-center gap-3 p-1 px-2 -m-1 -mx-2 rounded transition-colors duration-150 cursor-pointer hover:bg-[var(--nim-bg-hover)]"
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand status bar' : 'Collapse status bar'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        }}
      >
        <div className="status-bar-title flex items-center gap-2 font-semibold text-[var(--nim-text)] text-sm">
          <MaterialSymbol icon={isCollapsed ? 'chevron_right' : 'expand_more'} size={18} />
          <MaterialSymbol icon={model.icon} size={18} />
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

      {!isCollapsed && (
        <div className="status-bar-content mt-2">
          <TrackerFieldPills
            labelFields={labelFields}
            fields={chipFields}
            values={chipValues}
            teamMembers={teamMembers}
            relationshipCandidates={relationshipCandidates}
            onSave={handleFieldChange}
            onOpenItem={onOpenItem}
            onCreateCollection={onCreateCollection}
            className="status-bar-field-pills"
            testIdBase="tracker-status-bar-field"
          />
        </div>
      )}
    </div>
  );
};
