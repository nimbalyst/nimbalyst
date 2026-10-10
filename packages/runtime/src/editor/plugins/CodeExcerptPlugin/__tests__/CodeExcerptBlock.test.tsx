/**
 * Opening a page never writes file contents into it: an excerpt received from
 * a teammate (empty snapshot or not) is only read for the badge.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, type LexicalEditor } from 'lexical';

const readExcerptFile = vi.fn(async () => ({ text: 'SECRET=hunter2\n', head: 'abc123def', absolutePath: '/repo/.env' }));
vi.mock('../CodeExcerptCallbacks', () => ({
  readExcerptFile: (...args: unknown[]) => readExcerptFile(...(args as [])),
  openExcerptFile: vi.fn(),
  toWorkspaceRelative: (path: string) => path,
}));

import { CodeExcerptBlock } from '../CodeExcerptBlock';
import { $createCodeExcerptNode, CodeExcerptNode } from '../CodeExcerptNodeCore';

const SHARED = 'path: .env\nlines: 1-100\n---\n';

function Harness({ onEditor }: { onEditor: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  const [key, setKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    onEditor(editor);
    editor.update(() => {
      const node = $createCodeExcerptNode({ source: SHARED });
      $getRoot().append(node);
      setKey(node.getKey());
    }, { discrete: true });
  }, [editor, onEditor]);
  return key ? <CodeExcerptBlock source={SHARED} nodeKey={key} /> : null;
}

describe('CodeExcerptBlock', () => {
  it('does not write a received excerpt with an empty snapshot', async () => {
    let editor: LexicalEditor | null = null;
    render(
      <LexicalComposer initialConfig={{
        namespace: 'excerpt',
        nodes: [CodeExcerptNode],
        onError: (error) => { throw error; },
      }}>
        <Harness onEditor={(value) => { editor = value; }} />
      </LexicalComposer>,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const source = editor!.getEditorState().read(() => ($getRoot().getChildren().find((node) => node instanceof CodeExcerptNode) as CodeExcerptNode).getSource());
    expect(source).toBe(SHARED);
  });
});
