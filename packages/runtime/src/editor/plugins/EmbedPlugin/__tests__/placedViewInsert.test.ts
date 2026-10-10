// @vitest-environment node
import { $createParagraphNode, $getRoot, createEditor } from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedFileNode, $isEmbeddedFileNode } from '../EmbeddedFileNodeCore';
import {
  INSERT_PLACED_VIEW_COMMAND,
  registerPlacedViewInsert,
  setPlacedViewScopeResolver,
  type PlacedViewInsertPayload,
} from '../placedViewInsert';

afterEach(() => setPlacedViewScopeResolver(undefined));

function insertInto(payload: PlacedViewInsertPayload): string | null {
  const editor = createEditor({ nodes: [EmbeddedFileNode], onError: (error) => { throw error; } });
  registerPlacedViewInsert(editor);
  editor.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.select();
  }, { discrete: true });
  editor.update(() => { editor.dispatchCommand(INSERT_PLACED_VIEW_COMMAND, payload); }, { discrete: true });
  let src: string | null = null;
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChild();
    src = $isEmbeddedFileNode(node) ? node.getSrc() : null;
  });
  return src;
}

describe('placing a view from the slash menu', () => {
  it('writes a console link for the scope the host gives the page', () => {
    const resolver = vi.fn(() => ({ orgId: 'o1', projectId: 'p1' }));
    setPlacedViewScopeResolver(resolver);
    expect(insertInto({ target: { kind: 'type', typeId: 'competitor' }, label: 'Competitors' }))
      .toBe('https://console.nimbalyst.com/org/o1/project/p1/view/type/competitor');
    // An editor that is not mounted has no root element, so there is no document path to read.
    expect(resolver).toHaveBeenCalledWith(null);
  });

  it('writes the app link when the host names no scope', () => {
    expect(insertInto({ target: { kind: 'marks', marks: 'decided' }, label: 'Decisions' })).toBe('nimbalyst://view/marks?kind=decided');
  });
});
