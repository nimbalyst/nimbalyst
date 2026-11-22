import { isCollabUri } from '@nimbalyst/collab-protocol';
import type { TabData } from '../../contexts/TabsContext';
import { detectFileType, type SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { getTextSelection } from '../UnifiedAI/TextSelectionIndicator';
import { getActiveEditorContextItems } from '../../stores/editorContextStore';
import { parsePersonalPageUri } from '../../../shared/personalPageUri';

/** Search, Types and other navigation tabs do not represent a document. */
export function pagesDocumentIdentity(tab: Pick<TabData, 'filePath' | 'fileName'> | null | undefined): SerializableDocumentContext {
  if (!tab) return {};
  const { filePath, fileName } = tab;
  if (!isCollabUri(filePath) && !parsePersonalPageUri(filePath) &&
      !filePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(filePath)) return {};
  return { filePath, fileName };
}

/** Read the active page on send; selection and indicator use the same identity. */
export async function getPagesDocumentContext(
  tab: Pick<TabData, 'filePath' | 'fileName'> | null | undefined,
  liveContent: { filePath: string; read: () => string } | undefined,
  readFile: (filePath: string) => Promise<string>,
): Promise<SerializableDocumentContext> {
  const identity = pagesDocumentIdentity(tab);
  const filePath = identity.filePath;
  if (!filePath) return {};

  const personal = parsePersonalPageUri(filePath);
  const getContent = liveContent?.filePath === filePath ? liveContent.read : undefined;
  // Shared and personal pages live in their editors, never at a disk path.
  const content = getContent ? getContent() : isCollabUri(filePath) || personal ? '' : await readFile(filePath);
  const selected = getTextSelection();
  const textSelection = selected?.filePath === filePath ? selected : undefined;
  return {
    ...identity,
    fileType: personal ? 'personal-page' : detectFileType(filePath),
    content,
    textSelection,
    textSelectionTimestamp: textSelection?.timestamp,
    editorContextItems: getActiveEditorContextItems(filePath),
  };
}
