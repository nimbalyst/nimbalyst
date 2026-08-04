import { act, screen } from '@testing-library/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical';

/**
 * Driving the composer from a test.
 *
 * Lives outside `__tests__` on purpose: the electron-scoped vitest config
 * collects EVERY file under `__tests__`, so a helper there is reported as a
 * suite with no tests.
 *
 * Test access to the composer's editor.
 *
 * jsdom cannot dispatch real typing into a contenteditable, so tests drive the
 * editor through its own API -- the same path a keystroke takes once the
 * browser has produced the mutation -- and read the message text back off the
 * `data-composer-text` attribute the input publishes.
 */
export function composerEditor(): LexicalEditor {
  const node = screen.getByTestId('comment-composer-input') as HTMLElement & {
    __lexicalEditor?: LexicalEditor;
  };
  const editor = node.__lexicalEditor;
  if (!editor) throw new Error('composer input is not a Lexical editor');
  return editor;
}

/** The message text the composer would send. */
export function composerText(): string {
  return screen.getByTestId('comment-composer-input').getAttribute('data-composer-text') ?? '';
}

/** Replace the whole message, leaving the caret at the end. */
export function type(value: string, format?: TextFormatType): void {
  const editor = composerEditor();
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const text = $createTextNode(value);
        if (format) text.toggleFormat(format);
        paragraph.append(text);
        root.append(paragraph);
        text.selectEnd();
      },
      { discrete: true },
    );
  });
}

/** Append to the message, leaving the caret at the end. */
export function typeMore(value: string): void {
  const editor = composerEditor();
  act(() => {
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(value);
      },
      { discrete: true },
    );
  });
}

/** Toggle a mark on the current selection, as Cmd+B would. */
export function format(mark: TextFormatType): void {
  const editor = composerEditor();
  act(() => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, mark);
    flush(editor);
  });
}

/** Press Enter (or Shift+Enter) in the input, through Lexical's command path. */
export function pressEnter({ shift = false }: { shift?: boolean } = {}): void {
  const editor = composerEditor();
  act(() => {
    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift }),
    );
    flush(editor);
  });
}

/**
 * Commit whatever a command listener queued. An update started inside a command
 * listener commits with the outer update, which has not finished when
 * `dispatchCommand` returns; a discrete no-op update settles it.
 */
function flush(editor: LexicalEditor): void {
  editor.update(() => {}, { discrete: true });
}
