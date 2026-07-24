import * as path from 'path';

export interface ExtensionFindFilesPlan {
  normalizedPattern: string;
  scanRoot: string;
}

function hasGlobMagic(segment: string): boolean {
  return /[*?\[{]/.test(segment);
}

export function buildExtensionFindFilesPlan(dirPath: string, pattern: string): ExtensionFindFilesPlan {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const segments = normalizedPattern.split('/').filter(Boolean);
  const literalPrefix: string[] = [];

  for (const segment of segments) {
    if (hasGlobMagic(segment)) {
      break;
    }
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      break;
    }
    literalPrefix.push(segment);
  }

  const scanRoot = literalPrefix.length > 0
    ? path.resolve(dirPath, ...literalPrefix)
    : path.resolve(dirPath);

  return {
    normalizedPattern,
    scanRoot,
  };
}
