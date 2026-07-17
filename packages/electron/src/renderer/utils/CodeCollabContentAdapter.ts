import { createTextCollabContentAdapter } from '@nimbalyst/extension-sdk';
import { MONACO_TEXT_FILE_EXTENSIONS } from './fileTypeDetector';

export const CODE_COLLAB_FILE_EXTENSIONS = MONACO_TEXT_FILE_EXTENSIONS.filter(
  suffix => suffix !== '.md' && suffix !== '.markdown' && suffix !== '.mdc',
);

export const CodeCollabContentAdapter = createTextCollabContentAdapter({
  documentType: 'code',
  fileExtensions: CODE_COLLAB_FILE_EXTENSIONS,
  textField: 'content',
});

export function getCodeCollabExportFileName(
  sourceName: string,
  fileExtension?: string,
): string {
  const leafName = sourceName.slice(
    Math.max(sourceName.lastIndexOf('/'), sourceName.lastIndexOf('\\')) + 1,
  ) || 'document';
  const currentSuffix = [...CodeCollabContentAdapter.fileExtensions]
    .sort((left, right) => right.length - left.length)
    .find(suffix => leafName.toLowerCase().endsWith(suffix.toLowerCase()));
  const preferredSuffix = fileExtension
    ?? currentSuffix
    ?? CodeCollabContentAdapter.fileExtensions[0]
    ?? '.txt';

  if (leafName.toLowerCase().endsWith(preferredSuffix.toLowerCase())) {
    return leafName;
  }
  return `${currentSuffix ? leafName.slice(0, -currentSuffix.length) : leafName}${preferredSuffix}`;
}
