/**
 * What a typed page's header may change. A table type's row is read-only on
 * its page: the type's table is where rows are edited, and the page offers
 * only the convert-to-pages action, so nothing here can write the CSV. In a
 * static export nothing is editable.
 */
export interface TypedPageEditing {
  editable: boolean;
  onRename: (title: string) => void;
  onUpdateField: (field: { name: string }, value: unknown) => void;
  onArchive: (() => void) | undefined;
}

export function typedPageEditing(
  storage: 'pages' | 'table',
  published: boolean,
  handlers: { update: (updates: Record<string, unknown>) => Promise<void>; archive: () => void; fail: (error: unknown) => void },
): TypedPageEditing {
  if (storage === 'table' || published) return { editable: false, onRename: () => {}, onUpdateField: () => {}, onArchive: undefined };
  return {
    editable: true,
    onRename: (title) => void handlers.update({ title }).catch(handlers.fail),
    onUpdateField: (field, value) => void handlers.update({ [field.name]: value }).catch(handlers.fail),
    onArchive: handlers.archive,
  };
}
