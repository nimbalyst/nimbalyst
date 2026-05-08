// console.log('[RENDERER] index.tsx executing at', new Date().toISOString());

// Check if this is the hidden capture window (used for flash-free offscreen screenshots).
// The capture window loads the same renderer URL with ?mode=capture but skips all heavy
// initialization (Monaco, PostHog, React, settings). It only sets up the offscreen editor
// system for mounting editors and capturing screenshots via native capturePage().
const isCaptureMode = new URLSearchParams(window.location.search).get('mode') === 'capture';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './styles/components.css';
import posthog from "posthog-js";
import {PostHogProvider} from "posthog-js/react";
import { initMonacoEditor } from './utils/monacoConfig';
import { store } from '@nimbalyst/runtime/store';
import { registerLocalAssetUrlConverter } from '@nimbalyst/runtime';
import { nimAssetUrl } from './utils/assetUrl';
import { initializeTheme } from './hooks/useTheme';
import { offscreenEditorRenderer } from './services/OffscreenEditorRenderer';
import {
  voiceModeSettingsAtom,
  initVoiceModeSettings,
  notificationSettingsAtom,
  initNotificationSettings,
  advancedSettingsAtom,
  initAdvancedSettings,
  syncConfigAtom,
  initSyncConfig,
  aiDebugSettingsAtom,
  initAIDebugSettings,
  aiProviderSettingsAtom,
  initAIProviderSettings,
  agentModeSettingsAtom,
  initAgentModeSettings,
  developerFeatureSettingsAtom,
  initDeveloperFeatureSettings,
  externalEditorSettingsAtom,
  initExternalEditorSettings,
  debugFlagsAtom,
  initDebugFlags,
} from './store/atoms/appSettings';
import {
  claudeUsageIndicatorEnabledAtom,
  initClaudeUsageIndicatorSetting,
} from './store/atoms/claudeUsageAtoms';
import {
  codexUsageIndicatorEnabledAtom,
  initCodexUsageIndicatorSetting,
} from './store/atoms/codexUsageAtoms';
import { initVoiceModeListeners } from './store/listeners/voiceModeListeners';
import {
  autoCommitEnabledAtom,
  initAutoCommitSetting,
} from './store/atoms/autoCommitAtoms';
import {
  diffPeekSizeAtom,
  initDiffPeekSize,
} from './store/atoms/diffPeekSizeAtoms';
import {
  trackerAutomationAtom,
  initTrackerAutomationSettings,
} from './store/atoms/trackerAutomationAtoms';

// console.log('[RENDERER] Imports complete at', new Date().toISOString());

// Issue #146: route runtime local-asset URLs through the `nim-asset://`
// custom protocol. The main window runs with `webSecurity: true`, which
// blocks `<img src="file://...">`. Must register before any component
// renders an image. Runs in both normal and capture mode.
registerLocalAssetUrlConverter(nimAssetUrl);

// Initialize offscreen editor renderer and set up IPC listeners.
// This runs in BOTH normal mode and capture mode.
offscreenEditorRenderer.initialize();

window.electronAPI.onOffscreenEditorMount(async (payload: { filePath: string; workspacePath: string }) => {
  try {
    await offscreenEditorRenderer.mountEditor(payload.filePath, payload.workspacePath);
  } catch (error) {
    console.error('[Renderer] Failed to mount offscreen editor:', error);
  }
});

window.electronAPI.onOffscreenEditorUnmount((payload: { filePath: string }) => {
  offscreenEditorRenderer.unmountEditor(payload.filePath);
});

// Handle screenshot capture requests.
// Renderer controls the full lifecycle: position, native capture via IPC, restore.
// This guarantees restore always happens (try/finally in captureScreenshot).
window.electronAPI.onOffscreenEditorCaptureScreenshotRequest(async (payload: { filePath: string; selector?: string; theme?: string; responseChannel: string }) => {
  try {
    const imageBase64 = await offscreenEditorRenderer.captureScreenshot(payload.filePath, payload.selector, payload.theme);
    await window.electronAPI.invoke(payload.responseChannel, { success: true, imageBase64 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await window.electronAPI.invoke(payload.responseChannel, { success: false, error: errorMessage });
  }
});

// In capture mode, initialize extensions (needed for mounting editors) but skip everything else.
if (isCaptureMode) {
  const { registerExtensionSystem } = await import('./plugins/registerExtensionSystem');
  await registerExtensionSystem();
  console.log('[CaptureWindow] Ready - extensions and offscreen editor renderer initialized');
} else {

// Initialize Monaco Editor before rendering any components
initMonacoEditor();

// Initialize theme from main process and set up IPC listener
// This must happen before React renders to avoid flash
initializeTheme();

// Expose offscreen renderer on window for main process access
(window as any).offscreenEditorRenderer = offscreenEditorRenderer;

// Initialize app settings atoms from main process
// This loads settings and hydrates the Jotai atoms before React renders
// MUST be awaited to ensure settings are loaded before components mount
await Promise.allSettled([
  initVoiceModeSettings().then((settings) => {
    store.set(voiceModeSettingsAtom, settings);
  }),
  initNotificationSettings().then((settings) => {
    store.set(notificationSettingsAtom, settings);
  }),
  initAdvancedSettings().then((settings) => {
    store.set(advancedSettingsAtom, settings);
  }),
  initSyncConfig().then((config) => {
    store.set(syncConfigAtom, config);
  }),
  initAIDebugSettings().then((settings) => {
    store.set(aiDebugSettingsAtom, settings);
  }),
  initAIProviderSettings().then((settings) => {
    store.set(aiProviderSettingsAtom, settings);
  }),
  initAgentModeSettings().then((settings) => {
    store.set(agentModeSettingsAtom, settings);
  }),
  initDeveloperFeatureSettings().then((settings) => {
    store.set(developerFeatureSettingsAtom, settings);
  }),
  initExternalEditorSettings().then((settings) => {
    store.set(externalEditorSettingsAtom, settings);
  }),
  initClaudeUsageIndicatorSetting().then((enabled) => {
    store.set(claudeUsageIndicatorEnabledAtom, enabled);
  }),
  initCodexUsageIndicatorSetting().then((enabled) => {
    store.set(codexUsageIndicatorEnabledAtom, enabled);
  }),
  initAutoCommitSetting().then((enabled) => {
    store.set(autoCommitEnabledAtom, enabled);
  }),
  initDiffPeekSize().then((size) => {
    if (size) store.set(diffPeekSizeAtom, size);
  }),
  initTrackerAutomationSettings().then((settings) => {
    store.set(trackerAutomationAtom, settings);
  }),
  initDebugFlags().then((flags) => {
    store.set(debugFlagsAtom, flags);
  }),
]);

// Initialize centralized voice mode IPC listeners (must be after settings are loaded)
initVoiceModeListeners();

const rootElement = document.getElementById('root') as HTMLElement;
// console.log('[RENDERER] Root element:', rootElement, 'at', new Date().toISOString());

const root = ReactDOM.createRoot(rootElement);
// console.log('[RENDERER] React root created at', new Date().toISOString());

const analyticsId = await window.electronAPI.analytics?.getDistinctId() ?? '';
const analyticsAllowed = await window.electronAPI.analytics?.allowedToSendAnalytics() ?? false;
const nimbalystVersion = await window.electronAPI.getAppVersion?.() ?? '';
const isDevInstallation = process.env.NODE_ENV?.toLowerCase() === 'development';
const isDevMode = process.env.IS_DEV_MODE === 'true';
const isOfficialBuild = process.env.OFFICIAL_BUILD === 'true';

// Add dev mode indicator to body for styling (only for npm run dev, not packaged builds or Playwright)
if (isDevMode && !(window as any).PLAYWRIGHT) {
  document.body.setAttribute('data-dev-mode', 'true');
  const devLabel = window.DEV_MODE_LABEL ?? 'DEV MODE';
  document.body.style.setProperty('--dev-mode-label', `'${devLabel}'`);
}

const posthogClient = posthog.init(
  'phc_s3lQIILexwlGHvxrMBqti355xUgkRocjMXW4LjV0ATw',
  {
    bootstrap: {
      distinctID: analyticsId,
    },
    autocapture: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    capture_exceptions: false,
    session_idle_timeout_seconds: 30 * 60, // 30 minutes
    loaded: (posthog) => {
      console.log(`[RENDERER] PostHog loaded (analytics ID: ${posthog.get_distinct_id()}, session: ${posthog.get_session_id()}, official build: ${isOfficialBuild})`);

      posthog.register({ nimbalyst_version: nimbalystVersion });

      // Mark users as dev users if they've ever used a non-official build
      // This property persists across all future events for this user
      if (!isOfficialBuild) {
        posthog.people.set_once({ is_dev_user: true });
      }
    },
    before_send: (event) => process.env.PLAYWRIGHT_TEST ? null : event,
    debug: isDevInstallation
  }
)

// syncs the session ID from posthog-js to the electron-side analytics service
posthog.onSessionId(async (sessionId: string, windowId, changeReason) => {
  window.electronAPI.analytics?.setSessionId(sessionId);
})

// IPC listeners (including ai:promptClaimed) live in store/listeners/* and
// are initialized inside App.tsx once React mounts.

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <JotaiProvider store={store}>
        <PostHogProvider client={posthogClient}>
          <App />
        </PostHogProvider>
      </JotaiProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// console.log('[RENDERER] React render called at', new Date().toISOString());

} // end of !isCaptureMode block
