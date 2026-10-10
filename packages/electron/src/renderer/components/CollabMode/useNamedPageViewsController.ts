import { useEffect, useState } from 'react';
import type { LexicalEditor } from 'lexical';
import { createNamedPageViewsController, type NamedPageViewsController } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/namedPageViewsController';

/** Built here, not in trackers-ui, so that bundle entry never loads the editor graph. */
export function useNamedPageViewsController(editor: LexicalEditor | null, typeId: string): NamedPageViewsController | null {
  const [controller, setController] = useState<NamedPageViewsController | null>(null);
  useEffect(() => {
    if (!editor) { setController(null); return; }
    const next = createNamedPageViewsController(editor, typeId);
    setController(next);
    return () => next.dispose();
  }, [editor, typeId]);
  return controller;
}
