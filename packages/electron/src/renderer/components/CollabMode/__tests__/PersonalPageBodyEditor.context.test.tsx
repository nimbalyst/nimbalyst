// @vitest-environment jsdom
import React, { useLayoutEffect, useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor } from 'lexical';
import type { EditorConfig } from '@nimbalyst/runtime/editor/EditorConfig';
import { getTextSelection, clearTextSelection } from '../../UnifiedAI/TextSelectionIndicator';

const body = vi.hoisted(() => ({ status: 'ready', initialContent: 'Initial text', editorEpoch: 0, onEdit: vi.fn() }));
vi.mock('../usePersonalPageBody', () => ({ usePersonalPageBody: () => body }));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { set: vi.fn() } }));
vi.mock('@nimbalyst/runtime/editor', () => ({ NimbalystEditor: TestEditor }));

let liveEditor: LexicalEditor;
function TestEditor({ config }: { config: EditorConfig }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const editor = createEditor({ namespace: 'personal-context', onError: error => { throw error; } });
    liveEditor = editor;
    editor.setRootElement(root.current);
    config.onGetContent?.(() => editor.getEditorState().read(() => $getRoot().getTextContent()));
    config.onEditorReady?.(editor);
    return () => editor.setRootElement(null);
  }, []);
  return <div ref={root} contentEditable tabIndex={0} />;
}

import { PersonalPageBodyEditor } from '../PersonalPageBodyEditor';

afterEach(() => {
  cleanup();
  clearTextSelection();
  vi.useRealTimers();
});

it('publishes Personal page selection and fresh body through the same chat identity after editor remount', () => {
  vi.useFakeTimers();
  let readContent: (() => string) | undefined;
  const onGetContentReady = (getContent: () => string) => { readContent = getContent; };
  const renderBody = () => <PersonalPageBodyEditor documentId="page-1" workspacePath="/workspace" onGetContentReady={onGetContentReady} />;
  const { rerender, unmount } = render(renderBody());

  const select = (text: string) => {
    liveEditor.getRootElement()?.focus();
    act(() => {
      liveEditor.update(() => {
        const node = $createTextNode(text);
        $getRoot().clear().append($createParagraphNode().append(node));
        node.select(0, 6);
      }, { discrete: true });
      vi.advanceTimersByTime(200);
    });
  };
  select('Chosen passage');
  expect(getTextSelection()).toMatchObject({ filePath: 'personal://page-1', text: 'Chosen' });
  expect(readContent?.()).toBe('Chosen passage');

  body.editorEpoch++;
  rerender(renderBody());
  select('Latest passage');
  expect(getTextSelection()).toMatchObject({ filePath: 'personal://page-1', text: 'Latest' });
  expect(readContent?.()).toBe('Latest passage');
  unmount();
  expect(getTextSelection()).toBeNull();
  expect(readContent?.()).toBe('');
});
