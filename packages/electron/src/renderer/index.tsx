// console.log('[RENDERER] index.tsx executing at', new Date().toISOString());

// Check if this is the hidden capture window (used for flash-free offscreen screenshots).
// The capture window loads the same renderer URL with ?mode=capture but skips all heavy
// initialization (Monaco, PostHog, React, settings). It only sets up the offscreen editor
// system for mounting editors and capturing screenshots via native capturePage().
const isCaptureMode = new URLSearchParams(window.location.search).get('mode') === 'capture';

// Must precede `react-dom`: this installs the DevTools hook shim the render
// profiler reads, and react-dom captures that hook once at module init.
// Records nothing until `window.__renderProfiler.start()`.
// See docs/RENDER_PERFORMANCE.md.
import './devtools/installRenderProfiler';

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
import {
  isAnalyticsConsentGranted,
  onAnalyticsConsentChange,
  setAnalyticsConsent,
} from './utils/analyticsConsent';
import { initAnalyticsListeners } from './store/listeners/analyticsListeners';
import { initializeTheme } from './hooks/useTheme';
import { offscreenEditorRenderer } from './services/OffscreenEditorRenderer';
import {
  voiceModeSettingsAtom,
  initVoiceModeSettings,
  notificationSettingsAtom,
  initNotificationSettings,
  advancedSettingsAtom,
  initAdvancedSettings,
  gutterCustomizationAtom,
  initGutterCustomization,
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
} from './store/atoms/appSettings';
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
import {
  hydrateSettingsAtoms,
  registerSettingsChangeListener,
} from './store/atoms/settingAtomFamily';
import { registerGutterCustomizationListener } from './store/listeners/gutterCustomizationListeners';
import { waitForMaterialSymbols } from './utils/materialSymbolsReady';

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

// Material Symbols uses text ligatures. Wait for the bundled font before any
// React chrome can paint, otherwise Chromium exposes names such as
// `progress_activity` through its fallback text font during startup.
await waitForMaterialSymbols();

// Initialize Monaco Editor before rendering any components
initMonacoEditor();

// Initialize theme from main process and set up IPC listener
// This must happen before React renders to avoid flash
initializeTheme();

// The tray panel window is transparent so macOS vibrancy shows through. Mark it
// before the first paint, otherwise the opaque root flashes over the material.
if (new URLSearchParams(window.location.search).get('mode') === 'tray-panel') {
  document.documentElement.classList.add('tray-panel-window');
}

// The island window is transparent so the menu bar shows through everywhere the
// island itself is not. Same reason as above: mark it before the first paint.
if (new URLSearchParams(window.location.search).get('mode') === 'menu-bar-island') {
  document.documentElement.classList.add('menu-bar-island-window');
}

// Expose offscreen renderer on window for main process access
(window as any).offscreenEditorRenderer = offscreenEditorRenderer;

// Initialize the flat-key settings system (SettingsService).
// Awaited before React mounts so every consumer of `useSetting(key)` reads
// the real persisted value on its first render, never a default. The
// broadcast listener keeps every window in lockstep on subsequent writes.
// See nimbalyst-local/plans/settings-atomwithstorage-rewrite.md for the
// design and shared/settings/keys.ts for the registry of keys.
try {
  const snapshot = await window.electronAPI.settingsGetAll();
  hydrateSettingsAtoms(snapshot as any);
  registerSettingsChangeListener();
} catch (err) {
  // Fail loud, fail fast: a missing settings snapshot means components would
  // render against defaults and any setter would clobber real settings on
  // disk via the legacy blob paths still in flight. Re-throw so the
  // ErrorBoundary surfaces the failure.
  console.error('[renderer] settings:getAll failed at startup; refusing to mount React', err);
  throw err;
}

// Initialize legacy app settings atoms from main process.
// These still drive most settings UI today; the flat-key SettingsService above
// is the migration target. Domains are being migrated key-by-key (starting
// with AI providers/keys), so for now we run both pipelines.
// MUST be awaited to ensure settings are loaded before components mount.
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
  initGutterCustomization().then((state) => {
    store.set(gutterCustomizationAtom, state);
    // Subscribe after seeding so other-window gutter changes (hide/show/reorder)
    // mirror into this window live instead of only after reload.
    registerGutterCustomizationListener();
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
  initAutoCommitSetting().then((enabled) => {
    store.set(autoCommitEnabledAtom, enabled);
  }),
  initDiffPeekSize().then((size) => {
    if (size) store.set(diffPeekSizeAtom, size);
  }),
  initTrackerAutomationSettings().then((settings) => {
    store.set(trackerAutomationAtom, settings);
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
const releaseAttribution = await window.electronAPI.analytics?.getReleaseAttribution?.().catch(() => null) ?? null;
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
    // posthog-js defaults these ON (`history_change` / `if_capture_pageview`),
    // and not setting `defaults` leaves them on. In an Electron shell there is
    // no meaningful page to view or leave -- a "pageview" is a window opening --
    // so they produced 241,643 events in 30 days that nothing consumed.
    capture_pageview: false,
    capture_pageleave: false,
    session_idle_timeout_seconds: 30 * 60, // 30 minutes
    loaded: (posthog) => {
      console.log(`[RENDERER] PostHog loaded (analytics ID: ${posthog.get_distinct_id()}, session: ${posthog.get_session_id()}, official build: ${isOfficialBuild})`);

      // Release attribution as super-properties, so every renderer capture
      // carries it without touching call sites. Resolved from the main service
      // rather than re-derived from env vars here, so both processes report the
      // same values.
      posthog.register({ nimbalyst_version: nimbalystVersion, ...(releaseAttribution ?? {}) });

      // `is_dev_user` is NOT set with a standalone `people.set_once()` here.
      // posthog-js turns that into a `$set` capture, and this callback runs on
      // every renderer window load -- 669,977 events in 30 days for a flag that
      // never changes after the first one. It rides along on outgoing events in
      // `before_send` below instead, which costs nothing.
    },
    // Single choke point for every renderer capture. Consulting the consent
    // gate here (rather than relying only on opt_out_capturing) means no
    // existing or future `posthog.capture(...)` call site can leak an event
    // while the user has analytics turned off.
    before_send: (event) => {
      if (process.env.PLAYWRIGHT_TEST) return null;
      if (!isAnalyticsConsentGranted()) return null;
      // Mark users as dev users if they've ever used a non-official build.
      // Attached to an event that was going to be sent anyway rather than
      // captured on its own, mirroring AnalyticsService.sendEvent in main.
      if (!isOfficialBuild && event) {
        event.properties = {
          ...event.properties,
          $set_once: { is_dev_user: true, ...event.properties?.$set_once },
        };
      }
      return event;
    },
    debug: isDevInstallation
  }
)

// Resolve the user's setting before anything can capture, then keep posthog-js
// itself in sync so it also stops its own background requests -- not just the
// events we hand it.
setAnalyticsConsent(analyticsAllowed);
if (analyticsAllowed) {
  // `captureEventName: false` matters: opt_in_capturing() captures an `$opt_in`
  // event by default, and this runs on every launch in every window. Applying
  // an already-granted setting is not a user action and must not emit.
  posthog.opt_in_capturing({ captureEventName: false });
} else {
  posthog.opt_out_capturing();
}

onAnalyticsConsentChange((enabled) => {
  // This path is an explicit toggle, so the default `$opt_in` event is wanted
  // here -- it mirrors the `analytics_opt_out` the main service records, and
  // fires once per user action rather than once per launch.
  if (enabled) posthog.opt_in_capturing(); else posthog.opt_out_capturing();
});

// Settings live in one window but the renderer client is per-window, so main
// broadcasts the change to every window rather than only the one that toggled.
initAnalyticsListeners();

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
