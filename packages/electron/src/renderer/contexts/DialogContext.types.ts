import type React from 'react';

/**
 * Dialog groups determine mutual exclusion behavior.
 * Dialogs within the same group are mutually exclusive (opening one closes others).
 */
export type DialogGroup =
  | 'navigation' // QuickOpen, SessionQuickOpen, PromptQuickOpen, ProjectQuickOpen
  | 'alert' // ErrorDialog, ConfirmDialog - can stack on top of other groups
  | 'onboarding' // FeatureWalkthrough, OnboardingDialog - sequential flow
  | 'settings' // ApiKeyDialog
  | 'help' // KeyboardShortcutsDialog - can appear over navigation
  | 'feedback' // FeedbackIntakeDialog
  | 'promotion' // DiscordInvitation
  | 'system'; // ProjectSelectionDialog

/**
 * Configuration for a registered dialog.
 */
export interface DialogConfig<TData = unknown> {
  /** Unique identifier for the dialog */
  id: string;
  /** Group determines mutual exclusion behavior */
  group: DialogGroup;
  /** React component to render for this dialog */
  component: React.ComponentType<DialogComponentProps<TData>>;
  /** Higher priority dialogs render on top. Default is 0. */
  priority?: number;
  /** Optional IPC event that triggers this dialog to open */
  ipcEvent?: string;
}

/**
 * Props passed to dialog components by the DialogProvider.
 */
export interface DialogComponentProps<TData = unknown> {
  /** Whether the dialog is currently open */
  isOpen: boolean;
  /** Callback to close the dialog */
  onClose: () => void;
  /** Data passed when opening the dialog */
  data: TData;
}

/**
 * Options for the confirm dialog.
 */
export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Active dialog entry with its data.
 */
export interface ActiveDialog<TData = unknown> {
  id: string;
  data: TData;
  openedAt: number; // For determining which is "topmost"
}

/**
 * The context value provided by DialogProvider.
 */
export interface DialogContextValue {
  /**
   * Open a dialog by ID, optionally passing data.
   * If the dialog is in a mutually exclusive group, other dialogs in that group will be closed.
   */
  open: <TData = unknown>(dialogId: string, data?: TData) => void;

  /**
   * Close a specific dialog by ID, or close the topmost dialog if no ID is provided.
   */
  close: (dialogId?: string) => void;

  /**
   * Check if a specific dialog is currently open.
   */
  isOpen: (dialogId: string) => boolean;

  /**
   * Get the IDs of all currently open dialogs.
   */
  activeDialogs: string[];

  /**
   * Show a confirmation dialog and return a promise that resolves to the user's choice.
   */
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;

  /**
   * Register a dialog configuration. Usually called at module load time.
   */
  registerDialog: <TData = unknown>(config: DialogConfig<TData>) => void;
}

/**
 * Props for the DialogProvider component.
 */
export interface DialogProviderProps {
  children: React.ReactNode;
  /** Workspace path passed to dialogs that need it */
  workspacePath?: string;
}
