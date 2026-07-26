// @vitest-environment jsdom
import React, { createRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep this a true unit test: the runtime barrel pulls in the whole provider
// graph, and all we need is MaterialSymbol to surface its icon name so we can
// assert which glyph rendered.
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-testid={`icon-${icon}`}>{icon}</span>,
}));

import { HeaderCreateButton } from '../HeaderCreateButton';

afterEach(() => cleanup());

describe('HeaderCreateButton', () => {
  it('renders the label and its leading type icon', () => {
    render(
      <HeaderCreateButton icon="note_add" label="New File" onClick={() => {}} testId="new-file-button" />
    );
    const btn = screen.getByTestId('new-file-button');
    expect(btn.textContent).toContain('New File');
    expect(screen.getByTestId('icon-note_add')).not.toBeNull();
    expect(btn.classList.contains('header-create-button')).toBe(true);
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(
      <HeaderCreateButton icon="add" label="New Session" onClick={onClick} testId="new-dropdown-button" />
    );
    fireEvent.click(screen.getByTestId('new-dropdown-button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the menu caret only when showCaret is set', () => {
    const { rerender } = render(
      <HeaderCreateButton icon="add" label="New" onClick={() => {}} />
    );
    expect(screen.queryByTestId('icon-expand_more')).toBeNull();
    rerender(<HeaderCreateButton icon="add" label="New" onClick={() => {}} showCaret />);
    expect(screen.queryByTestId('icon-expand_more')).not.toBeNull();
  });

  it('keeps the base class, appends a custom className, and forwards its ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <HeaderCreateButton
        ref={ref}
        icon="add"
        label="New Session"
        onClick={() => {}}
        className="session-history-new-button"
        testId="new-dropdown-button"
      />
    );
    const btn = screen.getByTestId('new-dropdown-button');
    expect(btn.classList.contains('header-create-button')).toBe(true);
    expect(btn.classList.contains('session-history-new-button')).toBe(true);
    expect(ref.current).toBe(btn);
  });

  it('defaults aria-label to the label but honors an explicit ariaLabel', () => {
    const { rerender } = render(
      <HeaderCreateButton icon="create_new_folder" label="New Folder" onClick={() => {}} testId="b" />
    );
    expect(screen.getByTestId('b').getAttribute('aria-label')).toBe('New Folder');
    rerender(
      <HeaderCreateButton
        icon="add"
        label="New Session"
        ariaLabel="Create new session, worktree, or terminal"
        onClick={() => {}}
        testId="b"
      />
    );
    expect(screen.getByTestId('b').getAttribute('aria-label')).toBe('Create new session, worktree, or terminal');
  });

  it('uses the accent fill for tone="primary" and the secondary fill by default', () => {
    const { rerender } = render(
      <HeaderCreateButton icon="add" label="New" onClick={() => {}} testId="t" />
    );
    expect(screen.getByTestId('t').className).toContain('bg-[var(--nim-bg-secondary)]');
    rerender(<HeaderCreateButton icon="add" label="New" tone="primary" onClick={() => {}} testId="t" />);
    const btn = screen.getByTestId('t');
    expect(btn.className).toContain('bg-[var(--nim-primary)]');
    expect(btn.className).not.toContain('bg-[var(--nim-bg-secondary)]');
  });
});
