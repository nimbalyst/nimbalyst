import type { PullRequestFileRow } from '../../services/RendererPullRequestService';

export interface PrDirectoryNode {
  path: string;
  displayPath: string;
  files: PullRequestFileRow[];
  subdirectories: Map<string, PrDirectoryNode>;
  fileCount: number;
}

export function buildPrDirectoryTree(files: PullRequestFileRow[]): PrDirectoryNode {
  const root: PrDirectoryNode = {
    path: '',
    displayPath: '',
    files: [],
    subdirectories: new Map(),
    fileCount: 0,
  };

  for (const file of files) {
    root.fileCount++;
    const parts = file.path.split('/');
    if (parts.length === 1) {
      root.files.push(file);
      continue;
    }

    let currentNode = root;
    const dirParts = parts.slice(0, -1);

    for (let index = 0; index < dirParts.length; index += 1) {
      const part = dirParts[index];
      const pathSoFar = dirParts.slice(0, index + 1).join('/');
      const existing = currentNode.subdirectories.get(part);
      if (existing) {
        currentNode = existing;
        currentNode.fileCount++;
        continue;
      }

      const nextNode: PrDirectoryNode = {
        path: pathSoFar,
        displayPath: part,
        files: [],
        subdirectories: new Map(),
        fileCount: 0,
      };
      currentNode.subdirectories.set(part, nextNode);
      currentNode = nextNode;
      currentNode.fileCount++;
    }

    currentNode.files.push(file);
  }

  return collapseDirectoryTree(root);
}

function collapseDirectoryTree(node: PrDirectoryNode): PrDirectoryNode {
  node.subdirectories.forEach((subdir, key) => {
    node.subdirectories.set(key, collapseDirectoryTree(subdir));
  });

  if (node.subdirectories.size === 1 && node.files.length === 0) {
    const [, childNode] = Array.from(node.subdirectories.entries())[0];
    return {
      ...childNode,
      displayPath: node.displayPath
        ? `${node.displayPath}/${childNode.displayPath}`
        : childNode.displayPath,
    };
  }

  return node;
}

export function getAllPrFolderPaths(
  node: PrDirectoryNode,
  paths: string[] = [],
): string[] {
  if (node.path) {
    paths.push(node.path);
  }
  node.subdirectories.forEach((subdir) => {
    getAllPrFolderPaths(subdir, paths);
  });
  return paths;
}
