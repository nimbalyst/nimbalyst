// @vitest-environment jsdom
import React from 'react';
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
} from 'lexical';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerSavedDescription } from '../TrackerSavedDescription';

describe('saved description recovery', () => {
  it('does not mutate on opening and inserts without replacing selected text', () => {
    const editor = createEditor({
      namespace: 'recovery-test',
      onError: (error) => {
        throw error;
      },
    });
    editor.focus = vi.fn();
    editor.update(
      () => {
        const text = $createTextNode('Keep later edits');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, text.getTextContentSize());
      },
      { discrete: true },
    );
    const body = () =>
      editor.getEditorState().read(() => $getRoot().getTextContent());
    render(
      <TrackerSavedDescription
        description="Recovered text"
        editor={editor}
        canInsert
      />,
    );
    fireEvent.click(screen.getByText('Saved description'));
    expect(body()).toBe('Keep later edits');
    fireEvent.click(screen.getByRole('button', { name: 'Insert into body' }));
    expect(body()).toContain('Keep later edits');
    expect(body()).toContain('Recovered text');
    expect(screen.getByText('Recovered text')).toBeDefined();
  });

  it('stays hidden when the description is already the body', () => {
    // Agent-created and imported items store the same text in both fields;
    // offering it back would duplicate the body on Insert.
    const { container } = render(
      <TrackerSavedDescription
        description={'Same text\n'}
        currentBody="Same text"
        editor={null}
        canInsert={false}
      />,
    );
    expect(container.querySelector('.tracker-saved-description')).toBeNull();
  });

  it('leaves insertion disabled when a shared body is not ready', () => {
    render(
      <TrackerSavedDescription
        description="Original text"
        editor={null}
        canInsert={false}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Insert into body',
          hidden: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
