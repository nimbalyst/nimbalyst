import React, { useState, useRef, useCallback, useReducer } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

interface JsonNodeProps {
  keyName: string | null;
  value: unknown;
  depth: number;
  onValueChange: (path: string[], newValue: unknown) => void;
  path: string[];
}

/**
 * Renders a single JSON node with expand/collapse for objects and arrays.
 */
function JsonNode({ keyName, value, depth, onValueChange, path }: JsonNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const entries = isObject ? Object.entries(value as object) : [];

  const handleDoubleClick = () => {
    if (!isObject) {
      setEditing(true);
      setEditValue(JSON.stringify(value));
    }
  };

  const handleEditComplete = () => {
    setEditing(false);
    try {
      const parsed = JSON.parse(editValue);
      onValueChange(path, parsed);
    } catch {
      // Invalid JSON, revert
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditComplete();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  const renderValue = () => {
    if (editing) {
      return (
        <input
          className="json-viewer-edit-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleEditComplete}
          onKeyDown={handleKeyDown}
          autoFocus
        />
      );
    }

    if (value === null) {
      return <span className="json-viewer-null">null</span>;
    }
    if (typeof value === 'boolean') {
      return <span className="json-viewer-boolean">{value.toString()}</span>;
    }
    if (typeof value === 'number') {
      return <span className="json-viewer-number">{value}</span>;
    }
    if (typeof value === 'string') {
      return <span className="json-viewer-string">"{value}"</span>;
    }
    if (isArray) {
      return expanded ? null : <span className="json-viewer-preview">[{entries.length} items]</span>;
    }
    if (isObject) {
      return expanded ? null : <span className="json-viewer-preview">{'{...}'}</span>;
    }
    return null;
  };

  return (
    <div className="json-viewer-node" style={{ paddingLeft: depth * 16 }}>
      <div className="json-viewer-row" onDoubleClick={handleDoubleClick}>
        {isObject && (
          <button
            className="json-viewer-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▼' : '▶'}
          </button>
        )}
        {keyName !== null && (
          <span className="json-viewer-key">"{keyName}": </span>
        )}
        {renderValue()}
      </div>
      {isObject && expanded && (
        <div className="json-viewer-children">
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              keyName={k}
              value={v}
              depth={depth + 1}
              path={[...path, k]}
              onValueChange={onValueChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Main JSON Viewer component.
 *
 * Uses useEditorLifecycle to handle all host lifecycle concerns
 * (loading, saving, echo detection, file watching, theme).
 * Parsed JSON data lives in a ref, not React state.
 */
export function JsonViewer({ host }: EditorHostProps) {
  const dataRef = useRef<unknown>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [, forceRender] = useReducer((x) => x + 1, 0);

  const { isLoading, error: loadError, markDirty } = useEditorLifecycle(host, {
    applyContent: (parsed: unknown) => {
      dataRef.current = parsed;
      setParseError(null);
      forceRender();
    },
    getCurrentContent: () => dataRef.current,
    parse: (raw) => JSON.parse(raw || '{}'),
    serialize: (data) => JSON.stringify(data, null, 2),
  });

  // Handle value changes from nodes
  const handleValueChange = useCallback((path: string[], newValue: unknown) => {
    if (dataRef.current === null) return;

    // Deep clone and update
    const newData = JSON.parse(JSON.stringify(dataRef.current));
    let current: any = newData;

    for (let i = 0; i < path.length - 1; i++) {
      current = current[path[i]];
    }

    if (path.length > 0) {
      current[path[path.length - 1]] = newValue;
    }

    dataRef.current = newData;
    markDirty();
    forceRender();
  }, [markDirty]);

  // Toolbar actions
  const handleFormat = () => {
    if (dataRef.current === null) return;
    // Data is already parsed, just force a re-render
    // (serialize will produce formatted output on save)
    forceRender();
  };

  const handleMinify = () => {
    // Minify is a display concern -- not applicable to tree view
    // but kept for API compatibility
  };

  if (loadError) {
    return <div className="json-viewer">Error: {loadError.message}</div>;
  }

  if (isLoading) {
    return <div className="json-viewer">Loading...</div>;
  }

  return (
    <div className="json-viewer">
      <div className="json-viewer-toolbar">
        <span className="json-viewer-title">JSON Viewer</span>
        <div className="json-viewer-actions">
          <button onClick={handleFormat} title="Format JSON">
            Format
          </button>
          <button onClick={handleMinify} title="Minify JSON">
            Minify
          </button>
        </div>
      </div>

      <div className="json-viewer-content">
        {parseError ? (
          <div className="json-viewer-error">{parseError}</div>
        ) : dataRef.current !== null ? (
          <JsonNode
            keyName={null}
            value={dataRef.current}
            depth={0}
            path={[]}
            onValueChange={handleValueChange}
          />
        ) : null}
      </div>
    </div>
  );
}
