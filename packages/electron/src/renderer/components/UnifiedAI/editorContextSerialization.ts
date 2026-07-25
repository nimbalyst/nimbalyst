import type { EditorContextItem } from '@nimbalyst/runtime';

export const MAX_EDITOR_CONTEXT_DATA_CHARS = 32_768;
const MAX_EDITOR_CONTEXT_ID_CHARS = 512;
const MAX_EDITOR_CONTEXT_LABEL_CHARS = 512;
const MAX_EDITOR_CONTEXT_DESCRIPTION_CHARS = 16_384;
const MAX_EDITOR_CONTEXT_ICON_CHARS = 128;
const MAX_EDITOR_CONTEXT_GROUP_CHARS = 256;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function cloneBoundedJson(data: unknown): unknown | undefined {
  try {
    const serialized = JSON.stringify(data);
    if (!serialized || serialized.length > MAX_EDITOR_CONTEXT_DATA_CHARS) return undefined;
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

/**
 * Reduce extension-owned context to a bounded, structured-clone-safe IPC shape.
 * Data is omitted unless the item explicitly opts in and supplies valid JSON.
 */
export function serializeEditorContextItemsForIpc(
  items: EditorContextItem[] | undefined
): EditorContextItem[] | undefined {
  if (!items?.length) return undefined;

  return items.map((item) => {
    const serialized: EditorContextItem = {
      id: truncate(String(item.id), MAX_EDITOR_CONTEXT_ID_CHARS),
      label: truncate(String(item.label), MAX_EDITOR_CONTEXT_LABEL_CHARS),
      description: truncate(String(item.description), MAX_EDITOR_CONTEXT_DESCRIPTION_CHARS),
    };

    if (item.icon) serialized.icon = truncate(String(item.icon), MAX_EDITOR_CONTEXT_ICON_CHARS);
    if (item.groupLabel) {
      serialized.groupLabel = truncate(String(item.groupLabel), MAX_EDITOR_CONTEXT_GROUP_CHARS);
    }

    if (item.includeData && item.data !== undefined) {
      const data = cloneBoundedJson(item.data);
      if (data !== undefined) {
        serialized.includeData = true;
        serialized.data = data;
      }
    }

    return serialized;
  });
}
