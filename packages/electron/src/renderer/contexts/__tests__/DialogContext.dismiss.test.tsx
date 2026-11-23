// @vitest-environment jsdom

/**
 * A dialog opened to ask a question has to tell its opener when it goes away
 * without answering -- otherwise the caller waits forever. The two exits that
 * never reach the dialog component's own `onClose` are the ones covered here:
 * ESC, which the provider handles itself, and being displaced by another
 * exclusive dialog.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { DialogProvider, dialogRef, registerDialog } from '../DialogContext';

function registerProbe(id: string): void {
  registerDialog<{ onDismiss?: () => void }>({
    id,
    group: 'system',
    component: () => <div data-testid={id} />,
    priority: 100,
  });
}

afterEach(cleanup);

describe('DialogProvider dismissal', () => {
  it('tells the opener when the dialog is closed by ESC or displaced by another', () => {
    registerProbe('probe-a');
    registerProbe('probe-b');
    render(<DialogProvider workspacePath="/workspace"><div /></DialogProvider>);

    const dismissedByEsc = vi.fn();
    act(() => dialogRef.current?.open('probe-a', { onDismiss: dismissedByEsc }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dismissedByEsc).toHaveBeenCalledTimes(1);

    const displaced = vi.fn();
    act(() => dialogRef.current?.open('probe-a', { onDismiss: displaced }));
    act(() => dialogRef.current?.open('probe-b', {}));
    expect(displaced).toHaveBeenCalledTimes(1);
  });

  it('leaves a dialog that keeps unsaved work open on ESC', () => {
    const onDismiss = vi.fn();
    registerDialog<{ onDismiss?: () => void }>({
      id: 'probe-keep',
      group: 'system',
      component: () => <div data-testid="probe-keep" />,
      keepsUnsavedWork: true,
    });
    const view = render(<DialogProvider workspacePath="/workspace"><div /></DialogProvider>);
    act(() => dialogRef.current?.open('probe-keep', { onDismiss }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.queryByTestId('probe-keep')).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('opens a new dialog on top of one that keeps unsaved work, and ESC then closes only the new one', () => {
    // A higher priority than the dialog opened over it, so priority alone would draw it on top.
    registerDialog({ id: 'probe-keep-2', group: 'system', component: () => <div data-testid="probe-keep-2" />, keepsUnsavedWork: true, priority: 200 });
    registerProbe('probe-over');
    const view = render(<DialogProvider workspacePath="/workspace"><div /></DialogProvider>);
    act(() => dialogRef.current?.open('probe-keep-2', {}));
    act(() => dialogRef.current?.open('probe-over', {}));
    const kept = view.getByTestId('probe-keep-2');
    const over = view.getByTestId('probe-over');
    // The new dialog comes later in the page, so it draws on top.
    expect(kept.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.queryByTestId('probe-over')).toBeNull();
    expect(view.queryByTestId('probe-keep-2')).not.toBeNull();
  });
});
