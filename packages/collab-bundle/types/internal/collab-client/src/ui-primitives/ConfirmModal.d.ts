import React from 'react';
export interface ConfirmModalProps {
    title: string;
    message: string;
    confirmLabel: string;
    onSettle: (accepted: boolean) => void;
}
/**
 * In-app replacement for `window.confirm`, which blocks the renderer (and any
 * E2E run driving it) and does not match the app. Always destructive here: the
 * accept button carries the error color. Escape or Cancel cancels; Enter
 * submits from the focused accept button.
 */
export declare function ConfirmModal({ title, message, confirmLabel, onSettle }: ConfirmModalProps): React.JSX.Element;
/**
 * Mounts the dialog in its own root on `document.body` and resolves once the
 * user answers. Its own root keeps callers free of dialog state, so the docs-ui
 * eager bundle carries only the lazy import (see `confirmDestructive`).
 */
export declare function openConfirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
