/**
 * Central App Command Listeners
 *
 * Fire-and-forget command IPC events from the menu/main process. Each event
 * bumps a counter atom; components watch the counter via useEffect to act.
 *
 * Events handled:
 * - file-new-mockup -> newMockupRequestAtom
 * - file-new-browser-tab -> newBrowserTabRequestAtom
 * - toggle-ai-chat-panel -> toggleAIChatPanelRequestAtom
 *
 * Call initAppCommandListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  agentInsertPlanReferenceRequestAtom,
  closeActiveTabRequestAtom,
  confirmCloseUnsavedRequestAtom,
  extensionMarketplaceInstallRequestAtom,
  fileSaveRequestAtom,
  marketplaceInstallProgressAtom,
  newBrowserTabRequestAtom,
  sessionLaunchPopupRequestAtom,
  navigationGoBackRequestAtom,
  navigationGoForwardRequestAtom,
  newMockupRequestAtom,
  openNavigationDialogRequestAtom,
  reopenLastClosedTabRequestAtom,
  setContentModeRequestAtom,
  showDiscordInvitationRequestAtom,
  showExtensionProjectIntroDialogRequestAtom,
  showFigmaMcpMigrationRequestAtom,
  showProjectSelectionDialogRequestAtom,
  showSessionImportDialogRequestAtom,
  showTrustToastRequestAtom,
  toggleAIChatPanelRequestAtom,
  unifiedOnboardingRequestAtom,
  windowsClaudeCodeWarningRequestAtom,
  type InstallProgressStage,
} from '../atoms/appCommands';

let onboardingCounter = 0;
let openNavigationDialogCounter = 0;
let extensionMarketplaceCounter = 0;
let setContentModeCounter = 0;
let agentInsertPlanReferenceCounter = 0;
let showProjectSelectionDialogCounter = 0;
let showExtensionProjectIntroDialogCounter = 0;
let marketplaceInstallProgressCounter = 0;

let initialized = false;

export function initAppCommandListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];

  const u1 = window.electronAPI?.on?.('file-new-mockup', () => {
    store.set(newMockupRequestAtom, (v) => v + 1);
  });
  if (typeof u1 === 'function') cleanups.push(u1);

  const uBrowserTab = window.electronAPI?.on?.('file-new-browser-tab', () => {
    store.set(newBrowserTabRequestAtom, (v) => v + 1);
  });
  if (typeof uBrowserTab === 'function') cleanups.push(uBrowserTab);

  const uSessionLaunchPopup = window.electronAPI?.on?.('session-launch-popup-open', () => {
    store.set(sessionLaunchPopupRequestAtom, (v) => v + 1);
  });
  if (typeof uSessionLaunchPopup === 'function') cleanups.push(uSessionLaunchPopup);

  const u2 = window.electronAPI?.on?.('toggle-ai-chat-panel', () => {
    store.set(toggleAIChatPanelRequestAtom, (v) => v + 1);
  });
  if (typeof u2 === 'function') cleanups.push(u2);

  const u3 = window.electronAPI?.on?.('file-save', () => {
    store.set(fileSaveRequestAtom, (v) => v + 1);
  });
  if (typeof u3 === 'function') cleanups.push(u3);

  const u4 = window.electronAPI?.on?.(
    'show-unified-onboarding',
    (options?: { forceNewUser?: boolean; forceExistingUser?: boolean }) => {
      onboardingCounter += 1;
      store.set(unifiedOnboardingRequestAtom, { version: onboardingCounter, options });
    },
  );
  if (typeof u4 === 'function') cleanups.push(u4);

  const u5 = window.electronAPI?.on?.('show-windows-claude-code-warning', () => {
    store.set(windowsClaudeCodeWarningRequestAtom, (v) => v + 1);
  });
  if (typeof u5 === 'function') cleanups.push(u5);

  const u6 = window.electronAPI?.on?.('open-navigation-dialog', (dialogId: string) => {
    openNavigationDialogCounter += 1;
    store.set(openNavigationDialogRequestAtom, {
      version: openNavigationDialogCounter,
      dialogId,
    });
  });
  if (typeof u6 === 'function') cleanups.push(u6);

  // Phase 1: App.tsx menu/main-process commands

  const subscribeCounter = (event: string, atomRef: typeof navigationGoBackRequestAtom) => {
    const u = window.electronAPI?.on?.(event, () => {
      store.set(atomRef, (v) => v + 1);
    });
    if (typeof u === 'function') cleanups.push(u);
  };

  subscribeCounter('navigation:go-back', navigationGoBackRequestAtom);
  subscribeCounter('navigation:go-forward', navigationGoForwardRequestAtom);
  subscribeCounter('show-discord-invitation', showDiscordInvitationRequestAtom);
  subscribeCounter('show-trust-toast', showTrustToastRequestAtom);
  subscribeCounter('show-session-import-dialog', showSessionImportDialogRequestAtom);
  subscribeCounter('show-figma-mcp-migration', showFigmaMcpMigrationRequestAtom);
  subscribeCounter('confirm-close-unsaved', confirmCloseUnsavedRequestAtom);
  subscribeCounter('close-active-tab', closeActiveTabRequestAtom);
  subscribeCounter('reopen-last-closed-tab', reopenLastClosedTabRequestAtom);

  const u7 = window.electronAPI?.on?.(
    'extension-marketplace:install-request',
    (request: { extensionId: string; requestedAt?: string }) => {
      extensionMarketplaceCounter += 1;
      store.set(extensionMarketplaceInstallRequestAtom, {
        version: extensionMarketplaceCounter,
        request,
      });
    },
  );
  if (typeof u7 === 'function') cleanups.push(u7);

  const u8 = window.electronAPI?.on?.('set-content-mode', (mode: string) => {
    setContentModeCounter += 1;
    store.set(setContentModeRequestAtom, { version: setContentModeCounter, mode });
  });
  if (typeof u8 === 'function') cleanups.push(u8);

  const u9 = window.electronAPI?.on?.('agent:insert-plan-reference', (planPath: string) => {
    agentInsertPlanReferenceCounter += 1;
    store.set(agentInsertPlanReferenceRequestAtom, {
      version: agentInsertPlanReferenceCounter,
      planPath,
    });
  });
  if (typeof u9 === 'function') cleanups.push(u9);

  const u10 = window.electronAPI?.on?.(
    'show-project-selection-dialog',
    (data: { filePath: string; fileName: string; suggestedWorkspace?: string }) => {
      showProjectSelectionDialogCounter += 1;
      store.set(showProjectSelectionDialogRequestAtom, {
        version: showProjectSelectionDialogCounter,
        data,
      });
    },
  );
  if (typeof u10 === 'function') cleanups.push(u10);

  const u11 = window.electronAPI?.on?.(
    'show-extension-project-intro-dialog',
    (data: { requestId: string }) => {
      showExtensionProjectIntroDialogCounter += 1;
      store.set(showExtensionProjectIntroDialogRequestAtom, {
        version: showExtensionProjectIntroDialogCounter,
        requestId: data.requestId,
      });
    },
  );
  if (typeof u11 === 'function') cleanups.push(u11);

  const u12 = window.electronAPI?.on?.(
    'extension-marketplace:install-progress',
    (event: { stage: InstallProgressStage; message: string }) => {
      marketplaceInstallProgressCounter += 1;
      store.set(marketplaceInstallProgressAtom, {
        version: marketplaceInstallProgressCounter,
        stage: event.stage,
        message: event.message,
      });
    },
  );
  if (typeof u12 === 'function') cleanups.push(u12);

  return () => {
    initialized = false;
    cleanups.forEach((c) => c());
  };
}
