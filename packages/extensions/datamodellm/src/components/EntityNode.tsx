/**
 * Entity Node Component
 *
 * A React Flow node that displays an entity (table/collection) with its fields.
 * Supports multiple view modes: compact, minimal, standard, full.
 */

import { memo, useState, useRef, useEffect, useMemo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Entity, Field, EntityViewMode, Database } from '../types';
import { computeHandleState } from '../utils/handleUtils';
import type { DataModelStoreApi } from '../store';

export interface EntityNodeData extends Record<string, unknown> {
  entity: Entity;
  isSelected: boolean;
  isHovered: boolean;
  viewMode: EntityViewMode;
  database: Database;
  store: DataModelStoreApi;
}

// Default handle state to prevent creating new objects on every render
const DEFAULT_FIELD_HANDLE_STATE = {
  showSourceHandle: false,
  showTargetHandle: false,
};

interface FieldRowProps {
  entityId: string;
  field: Field;
  viewMode: EntityViewMode;
  database: Database;
  showSourceHandle?: boolean;
  store: DataModelStoreApi;
}

const FieldRow = memo(function FieldRow({
  entityId,
  field,
  viewMode,
  database,
  showSourceHandle = false,
  store,
}: FieldRowProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingType, setIsEditingType] = useState(false);
  const [editName, setEditName] = useState(field.name);
  const [editType, setEditType] = useState(field.dataType);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingType && typeInputRef.current) {
      typeInputRef.current.focus();
      typeInputRef.current.select();
    }
  }, [isEditingType]);

  const updateField = (updates: Partial<Field>) => {
    const state = store.getState();
    const entity = state.entities.find((e) => e.id === entityId);
    if (!entity) return;

    const fields = entity.fields.map((f) =>
      f.id === field.id ? { ...f, ...updates } : f
    );
    state.updateEntity(entityId, { fields });
  };

  const handleNameDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditingName(true);
  };

  const handleTypeDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditingType(true);
  };

  const handleNameBlur = () => {
    if (editName.trim() && editName !== field.name) {
      updateField({ name: editName.trim() });
    } else {
      setEditName(field.name);
    }
    setIsEditingName(false);
  };

  const handleTypeBlur = () => {
    if (editType.trim() && editType !== field.dataType) {
      updateField({ dataType: editType.trim() });
    } else {
      setEditType(field.dataType);
    }
    setIsEditingType(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNameBlur();
    else if (e.key === 'Escape') {
      setEditName(field.name);
      setIsEditingName(false);
    }
  };

  const handleTypeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleTypeBlur();
    else if (e.key === 'Escape') {
      setEditType(field.dataType);
      setIsEditingType(false);
    }
  };

  // Show badges based on view mode
  const showBadges = viewMode === 'full' || viewMode === 'standard';
  const showDataType = viewMode !== 'compact';
  const isNoSQL = database === 'mongodb' || database === 'couchdb';

  // Show description in full mode
  const showDescription = viewMode === 'full' && field.description;

  return (
    <div className="datamodel-field-row">
      {/* Hidden target handles */}
      <Handle
        type="target"
        position={Position.Left}
        id={`field-${field.id}-target-left`}
        style={{ left: '-4px', opacity: 0, pointerEvents: 'none' }}
        className="datamodel-handle"
      />
      <Handle
        type="target"
        position={Position.Right}
        id={`field-${field.id}-target-right`}
        style={{ right: '-4px', opacity: 0, pointerEvents: 'none' }}
        className="datamodel-handle"
      />

      <div className="datamodel-field-wrapper">
        <div className="datamodel-field-content">
          {isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              className="datamodel-field-input"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="datamodel-field-name"
              onDoubleClick={handleNameDoubleClick}
              title="Double-click to edit"
            >
              {field.name}
            </span>
          )}

          <div className="datamodel-field-right">
            {showDataType && (
              <span className="datamodel-field-type">
                {isEditingType ? (
                  <input
                    ref={typeInputRef}
                    type="text"
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    onBlur={handleTypeBlur}
                    onKeyDown={handleTypeKeyDown}
                    className="datamodel-field-input datamodel-field-input-type"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span onDoubleClick={handleTypeDoubleClick} title="Double-click to edit">
                    {field.dataType}
                  </span>
                )}
              </span>
            )}

            {showBadges && (
              <div className="datamodel-field-badges">
                {!isNoSQL && (
                  <>
                    {field.isPrimaryKey && (
                      <span className="datamodel-badge datamodel-badge-pk">PK</span>
                    )}
                    {field.isForeignKey && (
                      <span className="datamodel-badge datamodel-badge-fk">FK</span>
                    )}
                  </>
                )}
                {isNoSQL && (
                  <>
                    {field.name === '_id' && (
                      <span className="datamodel-badge datamodel-badge-id">_id</span>
                    )}
                    {field.isArray && (
                      <span className="datamodel-badge datamodel-badge-arr">ARR</span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {showDescription && (
          <div className="datamodel-field-description">{field.description}</div>
        )}
      </div>

      {/* Source handles */}
      {showSourceHandle && (
        <>
          <Handle
            type="source"
            position={Position.Left}
            id={`field-${field.id}-source-left`}
            style={{ left: '-4px' }}
            className="datamodel-handle datamodel-handle-source"
          />
          <Handle
            type="source"
            position={Position.Right}
            id={`field-${field.id}-source-right`}
            style={{ right: '-4px' }}
            className="datamodel-handle datamodel-handle-source"
          />
        </>
      )}
    </div>
  );
});

function EntityNodeComponent({ data, selected }: NodeProps<Node<EntityNodeData>>) {
  const { entity, isSelected, isHovered, viewMode, database, store } = data as EntityNodeData;

  // Compute handle state for all fields in this entity
  const state = store.getState();
  const handleState = useMemo(
    () => computeHandleState(entity, state.entities, state.relationships),
    [entity, state.entities, state.relationships]
  );

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(entity.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync editName with entity.name when not editing
  useEffect(() => {
    if (!isEditingName) {
      setEditName(entity.name);
    }
  }, [entity.name, isEditingName]);

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
    }
  }, [isEditingName]);

  const handleNameDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditingName(true);
  };

  const handleNameBlur = () => {
    if (editName.trim() && editName !== entity.name) {
      store.getState().updateEntity(entity.id, { name: editName.trim() });
    } else {
      setEditName(entity.name);
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNameBlur();
    else if (e.key === 'Escape') {
      setEditName(entity.name);
      setIsEditingName(false);
    }
  };

  const isNoSQL = database === 'mongodb' || database === 'couchdb';
  const isActuallySelected = selected || isSelected;
  const isCompact = viewMode === 'compact';

  // Compact mode: just show entity name, field count, and description
  if (isCompact) {
    const fieldCount = entity.fields.length;
    const fieldLabel = fieldCount === 1 ? '1 field' : `${fieldCount} fields`;

    return (
      <div
        className={`datamodel-entity datamodel-entity-compact ${isActuallySelected ? 'datamodel-entity-selected' : ''} ${
          isHovered ? 'datamodel-entity-hovered' : ''
        }`}
      >
        {/* Entity-wide handles */}
        <Handle type="target" position={Position.Top} id="target-top" className="datamodel-handle-invisible" />
        <Handle type="target" position={Position.Left} id="target-left" className="datamodel-handle-invisible" />
        <Handle type="target" position={Position.Bottom} id="target-bottom" className="datamodel-handle-invisible" />
        <Handle type="target" position={Position.Right} id="target-right" className="datamodel-handle-visible" />
        <Handle type="source" position={Position.Top} id="source-top" className="datamodel-handle-invisible" />
        <Handle type="source" position={Position.Right} id="source-right" className="datamodel-handle-visible" />
        <Handle type="source" position={Position.Bottom} id="source-bottom" className="datamodel-handle-invisible" />
        <Handle type="source" position={Position.Left} id="source-left" className="datamodel-handle-invisible" />

        <div className="datamodel-entity-compact-content">
          <div className="datamodel-entity-compact-header">
            <div className="datamodel-entity-compact-icon">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            {isEditingName ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={handleNameKeyDown}
                className="datamodel-entity-name-input"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="datamodel-entity-compact-name"
                onDoubleClick={handleNameDoubleClick}
                title="Double-click to edit"
              >
                {entity.name}
              </span>
            )}
            <span className="datamodel-entity-compact-badge">{fieldLabel}</span>
          </div>
          {entity.description && (
            <div className="datamodel-entity-compact-description">{entity.description}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`datamodel-entity ${isActuallySelected ? 'datamodel-entity-selected' : ''} ${
        isHovered ? 'datamodel-entity-hovered' : ''
      }`}
    >
      {/* Entity-wide handles (invisible) */}
      <Handle type="target" position={Position.Top} id="target-top" className="datamodel-handle-invisible" />
      <Handle type="target" position={Position.Left} id="target-left" className="datamodel-handle-invisible" />
      <Handle type="target" position={Position.Bottom} id="target-bottom" className="datamodel-handle-invisible" />
      <Handle type="target" position={Position.Right} id="target-right" className="datamodel-handle-invisible" />
      <Handle type="source" position={Position.Top} id="source-top" className="datamodel-handle-invisible" />
      <Handle type="source" position={Position.Right} id="source-right" className="datamodel-handle-invisible" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="datamodel-handle-invisible" />
      <Handle type="source" position={Position.Left} id="source-left" className="datamodel-handle-invisible" />

      {/* Entity header */}
      <div className="datamodel-entity-header">
        <svg className="datamodel-entity-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isNoSQL ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          )}
        </svg>
        {isEditingName ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            className="datamodel-entity-name-input"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <h3
            className="datamodel-entity-name"
            onDoubleClick={handleNameDoubleClick}
            title="Double-click to edit"
          >
            {entity.name}
          </h3>
        )}
      </div>

      {/* Fields list */}
      <div className="datamodel-entity-fields">
        {entity.fields.length > 0 ? (
          entity.fields.map((field) => {
            const fieldHandleState = handleState[field.id] || DEFAULT_FIELD_HANDLE_STATE;
            return (
              <FieldRow
                key={field.id}
                entityId={entity.id}
                field={field}
                viewMode={viewMode}
                database={database}
                showSourceHandle={fieldHandleState.showSourceHandle}
                store={store}
              />
            );
          })
        ) : (
          <div className="datamodel-entity-empty">No fields defined</div>
        )}
      </div>

      {/* Entity description */}
      {viewMode === 'full' && entity.description && (
        <div className="datamodel-entity-description">{entity.description}</div>
      )}
    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
