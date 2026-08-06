import React, { useEffect, useRef } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The modal shell every room-management surface in the org window mounts in.
 *
 * These dialogs are rendered by the org window rather than registered with the
 * global dialog registry: each one needs live org-scoped state (the roster, the
 * conversation directory) and hands a result back to the window (the created
 * conversation to navigate to). The registry's `dialogRef.open(id, data)` fixes
 * its data at open time, which is the wrong shape for that.
 */
export function OrgDialog({
  title,
  description,
  testId,
  width = 'w-[460px]',
  error,
  footer,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  testId: string;
  width?: string;
  error?: string | null;
  footer: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !cardRef.current) return;
      // Focus trap: Tab off either end of the dialog wraps back into it rather
      // than walking into the org window behind the overlay, which is inert to
      // the pointer but not to the keyboard.
      const focusable = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !cardRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Opening a dialog moves focus into it, and closing it hands focus back to
  // whatever opened it — otherwise the next Tab starts from the document root.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) {
      const target = card.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (target ?? card).focus();
    }
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="org-dialog-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      data-testid={`${testId}-overlay`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* The per-dialog marker rides on the shared shell so each surface keeps
          a stable kebab-case root class to address in devtools and tests. */}
      <div
        ref={cardRef}
        className={`org-dialog ${testId} flex max-h-[80vh] flex-col overflow-hidden rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-2xl ${width}`}
        data-testid={testId}
        data-component="OrgDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="org-dialog-header shrink-0 px-6 pb-3 pt-5">
          <div className="flex items-start gap-2">
            <h3 className="m-0 flex-1 text-lg font-semibold text-[var(--nim-text)]">{title}</h3>
            <button
              type="button"
              className="org-dialog-close flex size-6 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              data-testid={`${testId}-close`}
              aria-label="Close"
              onClick={onClose}
            >
              <MaterialSymbol icon="close" size={16} />
            </button>
          </div>
          {description && (
            <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">{description}</p>
          )}
        </div>

        {error && (
          <p
            className="org-dialog-error m-0 mx-6 mb-2 flex select-text items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--nim-error)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--nim-text)]"
            data-testid={`${testId}-error`}
            role="status"
          >
            <MaterialSymbol icon="error" size={14} /> {error}
          </p>
        )}

        <div className="org-dialog-body min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {children}
        </div>

        <div className="org-dialog-footer flex shrink-0 justify-end gap-2 border-t border-[var(--nim-border)] px-6 py-4">
          {footer}
        </div>
      </div>
    </div>
  );
}

export function OrgDialogField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="org-dialog-field mb-4">
      <label className="mb-1.5 block text-[12px] font-medium text-[var(--nim-text-muted)]">
        {label}
      </label>
      {children}
      {error
        ? <p className="org-dialog-field-error m-0 mt-1 text-[11px] text-[var(--nim-error)]">{error}</p>
        : hint
          ? <p className="m-0 mt-1 text-[11px] text-[var(--nim-text-disabled)]">{hint}</p>
          : null}
    </div>
  );
}

export const ORG_DIALOG_INPUT_CLASS =
  'w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2 text-[13px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]';

export function OrgDialogPrimaryButton({
  testId,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="org-dialog-primary rounded-md bg-[var(--nim-primary)] px-5 py-2 text-[13px] font-medium text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function OrgDialogSecondaryButton({
  testId,
  onClick,
  children,
}: {
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="org-dialog-secondary rounded-md border border-[var(--nim-border)] bg-transparent px-4 py-2 text-[13px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]"
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
