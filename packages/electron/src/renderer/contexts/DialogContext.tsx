import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { atom, useSetAtom } from 'jotai';
import type {
  ActiveDialog,
  ConfirmDialogOptions,
  DialogConfig,
  DialogContextValue,
  DialogProviderProps,
} from './DialogContext.types';

// Create the context with undefined default - we'll throw if used outside provider
const DialogContext = createContext<DialogContextValue | undefined>(undefined);

/**
 * Atom that tracks when DialogProvider is mounted and ready.
 * Use this to reactively wait for dialogs to be available.
 */
export const dialogReadyAtom = atom(false);

/**
 * Atom that tracks whether any dialogs are currently open.
 * Useful for preventing other UI (like walkthroughs) from showing when dialogs are active.
 */
export const hasActiveDialogsAtom = atom(false);

/**
 * Global ref for accessing dialog functions from outside React components.
 * This is useful for IPC handlers and other non-component code.
 *
 * Usage:
 * ```typescript
 * import { dialogRef } from './contexts/DialogContext';
 *
 * // In an IPC handler or callback:
 * dialogRef.current?.open('quick-open', { workspacePath: '...' });
 * ```
 */
export const dialogRef: React.MutableRefObject<DialogContextValue | null> = {
  current: null,
};

// Global registry of dialog configurations
const dialogRegistry = new Map<string, DialogConfig<unknown>>();

// Groups that can stack on top of other dialogs (alerts are important and can interrupt)
const STACKABLE_GROUPS = new Set(['alert']);

// All other groups are mutually exclusive - opening one closes all non-stackable dialogs

/**
 * DialogProvider manages all modal dialogs in the application.
 *
 * Features:
 * - Mutual exclusion within groups (e.g., only one navigation dialog at a time)
 * - ESC key to close topmost dialog
 * - Type-safe data passing to dialogs
 * - Promise-based confirm dialog
 */
export function DialogProvider({
  children,
  workspacePath,
}: DialogProviderProps) {
  // Map of dialog ID to its data (open dialogs only)
  const [activeDialogs, setActiveDialogs] = useState<Map<string, ActiveDialog>>(
    () => new Map(),
  );

  // For confirm dialog promise resolution
  const confirmResolveRef = useRef<((value: boolean) => void) | null>(null);
  const [confirmOptions, setConfirmOptions] =
    useState<ConfirmDialogOptions | null>(null);

  // Ref for accessing active dialogs in callbacks without stale closure
  const activeDialogsRef = useRef(activeDialogs);
  activeDialogsRef.current = activeDialogs;

  /**
   * Open a dialog by ID. If the dialog's group is mutually exclusive,
   * close any other open dialogs in that group first.
   */
  const open = useCallback(<TData,>(dialogId: string, data?: TData) => {
    const config = dialogRegistry.get(dialogId);
    if (!config) {
      console.error(`Dialog "${dialogId}" is not registered`);
      return;
    }

    setActiveDialogs((prev) => {
      const next = new Map(prev);

      // If this dialog is NOT stackable (not an alert), close all other non-stackable dialogs
      // This ensures only one "primary" dialog is open at a time
      if (!STACKABLE_GROUPS.has(config.group)) {
        for (const [id] of prev) {
          const otherConfig = dialogRegistry.get(id);
          // Keep stackable dialogs (alerts), close everything else
          if (otherConfig && !STACKABLE_GROUPS.has(otherConfig.group)) {
            next.delete(id);
          }
        }
      }

      // Open the requested dialog
      next.set(dialogId, {
        id: dialogId,
        data: data as unknown,
        openedAt: Date.now(),
      });

      return next;
    });
  }, []);

  /**
   * Close a specific dialog by ID, or close the topmost dialog if no ID provided.
   */
  const close = useCallback((dialogId?: string) => {
    setActiveDialogs((prev) => {
      if (prev.size === 0) return prev;

      const next = new Map(prev);

      if (dialogId) {
        // Close specific dialog
        next.delete(dialogId);
      } else {
        // Close topmost dialog (most recently opened)
        let topmost: ActiveDialog | undefined;
        for (const dialog of prev.values()) {
          if (!topmost || dialog.openedAt > topmost.openedAt) {
            topmost = dialog;
          }
        }
        if (topmost) {
          next.delete(topmost.id);
        }
      }

      return next;
    });
  }, []);

  /**
   * Check if a specific dialog is currently open.
   */
  const isOpen = useCallback(
    (dialogId: string): boolean => {
      return activeDialogs.has(dialogId);
    },
    [activeDialogs],
  );

  /**
   * Show a confirmation dialog and return a promise.
   */
  const confirm = useCallback(
    (options: ConfirmDialogOptions): Promise<boolean> => {
      return new Promise((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmOptions({
          confirmLabel: 'OK',
          cancelLabel: 'Cancel',
          destructive: false,
          ...options,
        });
        open('confirm-dialog');
      });
    },
    [open],
  );

  /**
   * Handle confirm dialog confirmation.
   */
  const handleConfirmDialogConfirm = useCallback(() => {
    close('confirm-dialog');
    if (confirmResolveRef.current) {
      confirmResolveRef.current(true);
      confirmResolveRef.current = null;
    }
    setConfirmOptions(null);
  }, [close]);

  /**
   * Handle confirm dialog cancellation.
   */
  const handleConfirmDialogCancel = useCallback(() => {
    close('confirm-dialog');
    if (confirmResolveRef.current) {
      confirmResolveRef.current(false);
      confirmResolveRef.current = null;
    }
    setConfirmOptions(null);
  }, [close]);

  /**
   * Register a dialog configuration.
   */
  const registerDialog = useCallback(<TData,>(config: DialogConfig<TData>) => {
    dialogRegistry.set(config.id, config as DialogConfig<unknown>);
  }, []);

  // ESC key to close topmost dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeDialogsRef.current.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };

    // Use capture phase to handle ESC before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [close]);

  // Build the list of active dialog IDs for the context value
  const activeDialogIds = useMemo(
    () => Array.from(activeDialogs.keys()),
    [activeDialogs],
  );

  const contextValue: DialogContextValue = useMemo(
    () => ({
      open,
      close,
      isOpen,
      activeDialogs: activeDialogIds,
      confirm,
      registerDialog,
    }),
    [open, close, isOpen, activeDialogIds, confirm, registerDialog],
  );

  // Track dialog ready state via Jotai atom
  const setDialogReady = useSetAtom(dialogReadyAtom);
  const setHasActiveDialogs = useSetAtom(hasActiveDialogsAtom);

  // Sync hasActiveDialogsAtom when dialogs change
  useEffect(() => {
    setHasActiveDialogs(activeDialogs.size > 0);
  }, [activeDialogs, setHasActiveDialogs]);

  // Populate the global ref for access from outside React components
  useEffect(() => {
    dialogRef.current = contextValue;
    setDialogReady(true);
    return () => {
      dialogRef.current = null;
      setDialogReady(false);
    };
  }, [contextValue, setDialogReady]);

  // Sort dialogs by priority and openedAt for rendering order
  const sortedDialogs = useMemo(() => {
    const dialogs = Array.from(activeDialogs.values());
    return dialogs.sort((a, b) => {
      const configA = dialogRegistry.get(a.id);
      const configB = dialogRegistry.get(b.id);
      const priorityA = configA?.priority ?? 0;
      const priorityB = configB?.priority ?? 0;

      // Higher priority renders on top
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Same priority: earlier opened renders below
      return a.openedAt - b.openedAt;
    });
  }, [activeDialogs]);

  return (
    <DialogContext.Provider value={contextValue}>
      {children}

      {/* Render all active dialogs */}
      {sortedDialogs.map((dialog) => {
        const config = dialogRegistry.get(dialog.id);
        if (!config) return null;

        const DialogComponent = config.component;

        // Special handling for confirm dialog
        if (dialog.id === 'confirm-dialog' && confirmOptions) {
          return (
            <DialogComponent
              key={dialog.id}
              isOpen={true}
              onClose={handleConfirmDialogCancel}
              data={{
                ...confirmOptions,
                onConfirm: handleConfirmDialogConfirm,
                onCancel: handleConfirmDialogCancel,
              }}
            />
          );
        }

        return (
          <DialogComponent
            key={dialog.id}
            isOpen={true}
            onClose={() => close(dialog.id)}
            data={dialog.data}
          />
        );
      })}
    </DialogContext.Provider>
  );
}

/**
 * Hook to access the dialog context.
 * Must be used within a DialogProvider.
 */
export function useDialog(): DialogContextValue {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider');
  }
  return context;
}

/**
 * Convenience hook for a specific dialog's state.
 */
export function useDialogState<TData = unknown>(dialogId: string) {
  const { isOpen, open, close } = useDialog();
  return {
    isOpen: isOpen(dialogId),
    open: (data?: TData) => open(dialogId, data),
    close: () => close(dialogId),
  };
}

/**
 * Get the dialog registry for use in registering dialogs.
 */
export function getDialogRegistry() {
  return dialogRegistry;
}

/**
 * Register a dialog configuration.
 * Can be called at module load time before the provider mounts.
 */
export function registerDialog<TData = unknown>(config: DialogConfig<TData>) {
  dialogRegistry.set(config.id, config as DialogConfig<unknown>);
}
