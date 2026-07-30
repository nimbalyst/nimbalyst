// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgDialog, OrgDialogPrimaryButton } from '../OrgDialog';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <OrgDialog
        title="Create a room"
        testId="test-dialog"
        onClose={onClose}
        footer={<OrgDialogPrimaryButton testId="test-dialog-submit" onClick={vi.fn()}>Create</OrgDialogPrimaryButton>}
      >
        <input data-testid="test-dialog-input" />
      </OrgDialog>,
    ),
  };
}

/**
 * Keyboard behaviour of the shell every room-management dialog mounts in: one
 * fix here is a fix in create-room, room settings, the DM picker and compose.
 */
describe('OrgDialog', () => {
  afterEach(() => cleanup());

  it('closes on Escape and on an overlay click', () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId('test-dialog-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the dialog on open', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByTestId('test-dialog-close'));
  });

  it('wraps Tab inside the dialog instead of walking into the window behind it', () => {
    renderDialog();
    const close = screen.getByTestId('test-dialog-close');
    const submit = screen.getByTestId('test-dialog-submit');

    submit.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });

  it('hands focus back to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = renderDialog();
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
