/**
 * App Command Atoms
 *
 * Counter atoms incremented every time a fire-and-forget command IPC event
 * arrives. Components watch these atoms via useEffect to react.
 *
 * Updated by store/listeners/appCommandListeners.ts.
 */

import { atom } from 'jotai';

export const newMockupRequestAtom = atom(0);
export const newBrowserTabRequestAtom = atom(0);
export const toggleAIChatPanelRequestAtom = atom(0);
export const fileSaveRequestAtom = atom(0);

export interface UnifiedOnboardingRequest {
  version: number;
  options?: { forceNewUser?: boolean; forceExistingUser?: boolean };
}
export const unifiedOnboardingRequestAtom = atom<UnifiedOnboardingRequest | null>(null);

export const windowsClaudeCodeWarningRequestAtom = atom(0);

export interface OpenNavigationDialogRequest {
  version: number;
  dialogId: string;
}
export const openNavigationDialogRequestAtom = atom<OpenNavigationDialogRequest | null>(null);

// App.tsx menu/main-process commands (Phase 1)

export const navigationGoBackRequestAtom = atom(0);
export const navigationGoForwardRequestAtom = atom(0);

export interface ExtensionMarketplaceInstallRequest {
  version: number;
  request: { extensionId: string; requestedAt?: string };
}
export const extensionMarketplaceInstallRequestAtom = atom<ExtensionMarketplaceInstallRequest | null>(null);

/**
 * Per-stage progress for the "Install from GitHub" flow. The listener bumps
 * `version` on every `extension-marketplace:install-progress` event so the
 * panel can update its status toast as the install advances through stages
 * (checking release, downloading, cloning, installing).
 */
export type InstallProgressStage =
  | 'checking-release'
  | 'downloading-release'
  | 'cloning'
  | 'installing'
  | 'done';

export interface MarketplaceInstallProgress {
  version: number;
  stage: InstallProgressStage;
  message: string;
}
export const marketplaceInstallProgressAtom = atom<MarketplaceInstallProgress | null>(null);

export interface SetContentModeRequest {
  version: number;
  mode: string;
}
export const setContentModeRequestAtom = atom<SetContentModeRequest | null>(null);

export interface AgentInsertPlanReferenceRequest {
  version: number;
  planPath: string;
}
export const agentInsertPlanReferenceRequestAtom = atom<AgentInsertPlanReferenceRequest | null>(null);

export interface ShowProjectSelectionDialogRequest {
  version: number;
  data: { filePath: string; fileName: string; suggestedWorkspace?: string };
}
export const showProjectSelectionDialogRequestAtom = atom<ShowProjectSelectionDialogRequest | null>(null);

export const showDiscordInvitationRequestAtom = atom(0);
export const showTrustToastRequestAtom = atom(0);
export const showSessionImportDialogRequestAtom = atom(0);

export interface ShowExtensionProjectIntroDialogRequest {
  version: number;
  requestId: string;
}
export const showExtensionProjectIntroDialogRequestAtom = atom<ShowExtensionProjectIntroDialogRequest | null>(null);

export const showFigmaMcpMigrationRequestAtom = atom(0);
export const confirmCloseUnsavedRequestAtom = atom(0);
export const closeActiveTabRequestAtom = atom(0);
export const reopenLastClosedTabRequestAtom = atom(0);
