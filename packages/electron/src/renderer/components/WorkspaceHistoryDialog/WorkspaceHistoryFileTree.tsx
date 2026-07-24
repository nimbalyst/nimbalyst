import React, { useMemo, useState } from 'react';
import { getFileIcon } from '@nimbalyst/runtime';

interface WorkspaceFile {
  path: string;
  latestTimestamp: number;
  snapshotCount: number;
  exists: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  file?: WorkspaceFile;
}

interface WorkspaceHistoryFileTreeProps {
  files: WorkspaceFile[];
  workspacePath: string;
  selectedFilePath: string | null;
  selectedDeletedFiles: Set<string>;
  onFileSelect: (filePath: string) => void;
  onDeletedFileToggle: (filePath: string, checked: boolean) => void;
}

export function WorkspaceHistoryFileTree({
  files,
  workspacePath,
  selectedFilePath,
  selectedDeletedFiles,
  onFileSelect,
  onDeletedFileToggle
}: WorkspaceHistoryFileTreeProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Build tree structure from flat file paths
  const tree = useMemo(() => {
    const root: TreeNode[] = [];
    const dirMap = new Map<string, TreeNode>();

    // Sort files by path for consistent ordering
    const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

    for (const file of sortedFiles) {
      // Get relative path from workspace
      const relativePath = file.path.replace(workspacePath + '/', '');
      const parts = relativePath.split('/');

      let currentLevel = root;
      let currentPath = workspacePath;

      // Create directory nodes
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        currentPath = currentPath + '/' + dirName;

        let dirNode = dirMap.get(currentPath);
        if (!dirNode) {
          dirNode = {
            name: dirName,
            path: currentPath,
            type: 'directory',
            children: []
          };
          dirMap.set(currentPath, dirNode);
          currentLevel.push(dirNode);
        }
        currentLevel = dirNode.children!;
      }

      // Add file node
      const fileName = parts[parts.length - 1];
      currentLevel.push({
        name: fileName,
        path: file.path,
        type: 'file',
        file
      });
    }

    // Sort each level: directories first, then alphabetically
    const sortLevel = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        if (node.children) {
          sortLevel(node.children);
        }
      }
    };
    sortLevel(root);

    return root;
  }, [files, workspacePath]);

  // Auto-expand directories that contain the selected file
  useMemo(() => {
    if (selectedFilePath) {
      const parts = selectedFilePath.replace(workspacePath + '/', '').split('/');
      let currentPath = workspacePath;
      const newExpanded = new Set(expandedDirs);

      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath + '/' + parts[i];
        newExpanded.add(currentPath);
      }

      if (newExpanded.size !== expandedDirs.size) {
        setExpandedDirs(newExpanded);
      }
    }
  }, [selectedFilePath, workspacePath]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderNode = (node: TreeNode, level: number) => {
    const isExpanded = expandedDirs.has(node.path);
    const isSelected = node.path === selectedFilePath;
    const isDeleted = node.file && !node.file.exists;
    const isChecked = selectedDeletedFiles.has(node.path);

    if (node.type === 'directory') {
      return (
        <div key={node.path}>
          <div
            className="workspace-history-tree-item workspace-history-tree-folder"
            style={{ paddingLeft: `${12 + level * 16}px` }}
            onClick={() => toggleDir(node.path)}
          >
            <span className="material-symbols-outlined workspace-history-folder-icon">
              {isExpanded ? 'folder_open' : 'folder'}
            </span>
            <span className="workspace-history-tree-name">{node.name}/</span>
          </div>
          {isExpanded && node.children && (
            <div className="workspace-history-tree-children">
              {node.children.map(child => renderNode(child, level + 1))}
            </div>
          )}
        </div>
      );
    }

    // File node
    return (
      <div
        key={node.path}
        className={`workspace-history-tree-item workspace-history-tree-file ${isSelected ? 'selected' : ''} ${isDeleted ? 'deleted' : ''} ${isChecked ? 'checked' : ''}`}
        style={{ paddingLeft: `${12 + level * 16}px` }}
        onClick={() => onFileSelect(node.path)}
      >
        {isDeleted && (
          <div
            className={`workspace-history-deleted-checkbox ${isChecked ? 'checked' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onDeletedFileToggle(node.path, !isChecked);
            }}
          >
            {isChecked && <span className="material-symbols-outlined">check</span>}
          </div>
        )}
        <span className={`material-symbols-outlined workspace-history-file-icon ${isDeleted ? 'deleted' : ''}`}>
          {getFileIcon(node.name)}
        </span>
        <span className="workspace-history-tree-name">{node.name}</span>
        {isDeleted && <span className="workspace-history-deleted-label">(deleted)</span>}
      </div>
    );
  };

  if (files.length === 0) {
    return (
      <div className="workspace-history-tree-empty">
        No files with history in this workspace
      </div>
    );
  }

  return (
    <div className="workspace-history-tree">
      {tree.map(node => renderNode(node, 0))}
    </div>
  );
}
