import { useState } from 'react';
import type { TestNode } from '../types';
import { StatusIcon } from './StatusIcon';

interface TestTreeNodeProps {
  node: TestNode;
  depth: number;
  onRun: (node: TestNode) => void;
  onSelect: (node: TestNode) => void;
  selectedId: string | null;
  onOpenFile: (filePath: string, line?: number) => void;
}

export function TestTreeNode({ node, depth, onRun, onSelect, selectedId, onOpenFile }: TestTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isSelected = node.id === selectedId;

  const handleClick = () => {
    if (hasChildren) {
      setExpanded((prev) => !prev);
    }
    onSelect(node);
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRun(node);
  };

  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.filePath) {
      onOpenFile(node.filePath, node.line);
    }
  };

  return (
    <div>
      <div
        className="pw-tree-node"
        data-selected={isSelected}
        data-depth={depth}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
      >
        {/* Expand/collapse chevron */}
        <span className="pw-tree-chevron" data-visible={hasChildren}>
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: 14,
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
            }}
          >
            chevron_right
          </span>
        </span>

        {/* Status icon */}
        <StatusIcon status={node.status} size={14} />

        {/* Name */}
        <span className="pw-tree-name" title={node.name}>
          {node.name}
        </span>

        {/* Duration */}
        {node.duration != null && (
          <span className="pw-tree-duration">
            {node.duration < 1000 ? `${node.duration}ms` : `${(node.duration / 1000).toFixed(1)}s`}
          </span>
        )}

        {/* Actions */}
        <span className="pw-tree-actions">
          <button className="pw-icon-btn" onClick={handleRun} title="Run">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              play_arrow
            </span>
          </button>
          {node.filePath && (
            <button className="pw-icon-btn" onClick={handleOpenFile} title="Open file">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                open_in_new
              </span>
            </button>
          )}
        </span>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TestTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onRun={onRun}
              onSelect={onSelect}
              selectedId={selectedId}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
