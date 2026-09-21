import { getFileType } from '../utils/fileTypeDetector';

/** Match extension overrides first, including compound suffixes, then built-ins. */
export function resolveScreenshotEditor<T>(
  filePath: string,
  findCustom: (suffix: string) => T | undefined
): { type: 'custom'; component: T } | { type: 'markdown' | 'code' | 'image' } {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  for (
    let dot = fileName.indexOf('.');
    dot >= 0;
    dot = fileName.indexOf('.', dot + 1)
  ) {
    const component = findCustom(fileName.slice(dot));
    if (component) return { type: 'custom', component };
  }
  return { type: getFileType(filePath) as 'markdown' | 'code' | 'image' };
}
