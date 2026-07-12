export interface FileDirectoryNode<T> {
  path: string;
  displayPath: string;
  files: T[];
  subdirectories: Map<string, FileDirectoryNode<T>>;
  fileCount: number;
}

/** Normalize filesystem separators for renderer-side path comparison and display. */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/[\\/]+/g, '/');
}

export function getFilePathBasename(filePath: string): string {
  const normalizedPath = normalizeFilePath(filePath);
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
}

/**
 * Return a forward-slash path relative to the workspace when the file is inside it.
 * Windows drive paths are compared case-insensitively to match filesystem behavior.
 */
export function getWorkspaceRelativeFilePath(filePath: string, workspacePath?: string): string {
  const normalizedFile = normalizeFilePath(filePath);
  if (!workspacePath) return normalizedFile;

  const normalizedWorkspace = normalizeFilePath(workspacePath).replace(/\/$/, '');
  const windowsDrivePath = /^[A-Za-z]:\//.test(normalizedFile)
    && /^[A-Za-z]:\//.test(normalizedWorkspace);
  const comparableFile = windowsDrivePath ? normalizedFile.toLowerCase() : normalizedFile;
  const comparableWorkspace = windowsDrivePath
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace;

  if (comparableFile === comparableWorkspace) return '';
  if (comparableFile.startsWith(`${comparableWorkspace}/`)) {
    return normalizedFile.slice(normalizedWorkspace.length + 1);
  }

  return normalizedFile;
}

function collapseDirectoryTree<T>(node: FileDirectoryNode<T>): FileDirectoryNode<T> {
  node.subdirectories.forEach((subdirectory, key) => {
    node.subdirectories.set(key, collapseDirectoryTree(subdirectory));
  });

  if (node.subdirectories.size === 1 && node.files.length === 0) {
    const childNode = node.subdirectories.values().next().value as FileDirectoryNode<T>;
    return {
      ...childNode,
      displayPath: node.displayPath
        ? `${node.displayPath}/${childNode.displayPath}`
        : childNode.displayPath,
    };
  }

  return node;
}

function updateFileCounts<T>(node: FileDirectoryNode<T>): number {
  let count = node.files.length;
  node.subdirectories.forEach(subdirectory => {
    count += updateFileCounts(subdirectory);
  });
  node.fileCount = count;
  return count;
}

/** Build a collapsed directory tree for arbitrary file records. */
export function buildFileDirectoryTree<T>(
  files: T[],
  getFilePath: (file: T) => string,
  workspacePath?: string,
): FileDirectoryNode<T> {
  const root: FileDirectoryNode<T> = {
    path: '',
    displayPath: '',
    files: [],
    subdirectories: new Map(),
    fileCount: 0,
  };

  files.forEach(file => {
    const relativePath = getWorkspaceRelativeFilePath(getFilePath(file), workspacePath);
    const parts = relativePath.split('/').filter(Boolean);

    if (parts.length <= 1) {
      root.files.push(file);
      return;
    }

    let currentNode = root;
    const directoryParts = parts.slice(0, -1);
    directoryParts.forEach((part, index) => {
      const path = directoryParts.slice(0, index + 1).join('/');
      let childNode = currentNode.subdirectories.get(part);
      if (!childNode) {
        childNode = {
          path,
          displayPath: part,
          files: [],
          subdirectories: new Map(),
          fileCount: 0,
        };
        currentNode.subdirectories.set(part, childNode);
      }
      currentNode = childNode;
    });
    currentNode.files.push(file);
  });

  updateFileCounts(root);
  return collapseDirectoryTree(root);
}

export function getFileDirectoryPaths<T>(node: FileDirectoryNode<T>): string[] {
  const paths = node.path ? [node.path] : [];
  node.subdirectories.forEach(subdirectory => {
    paths.push(...getFileDirectoryPaths(subdirectory));
  });
  return paths;
}
