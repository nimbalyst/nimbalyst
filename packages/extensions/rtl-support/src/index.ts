/**
 * RTL Support — Nimbalyst Extension
 * Entry point
 *
 * issue #237: تشخیص خودکار جهت RTL/LTR برای پاسخ‌های agent، prompt، و markdown.
 *
 * معماری (با API رسمی Nimbalyst):
 *  - hostComponent: RtlTranscriptHost — rehype plugin + component overrides
 *  - inputRtl: اعمال RTL روی فیلدهای ورودی کاربر
 *  - settings: configuration service + localStorage + settingsPanel UI
 *
 * @nimbalyst/runtime external است و توسط host تأمین می‌شه.
 */

import './styles.css';

import { RtlTranscriptHost } from './RtlTranscriptHost';
import { RtlSettingsPanel } from './RtlSettingsPanel';
import { loadSettings, saveSettings, resetSettings, type RtlSettings } from './settings';
import { startInputRtl, stopInputRtl } from './inputRtl';
import { setDebug, isDebug } from './debug';

/** hostComponents — توسط manifest > contributions.hostComponents ارجاع می‌شه */
export const hostComponents = {
  RtlTranscriptHost,
};

/** settingsPanel — توسط manifest > contributions.settingsPanel ارجاع می‌شه */
export const settingsPanel = {
  RtlSettingsPanel,
};

export const components = {};

interface ExtensionContext {
  services?: {
    configuration?: {
      get<T>(key: string, defaultValue?: T): T;
      update(key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void>;
    };
  };
  subscriptions?: Array<{ dispose(): void }>;
}

let currentSettings: RtlSettings = loadSettings();

/**
 * Extension رو فعال کن.
 */
export function activate(context?: ExtensionContext): void {
  currentSettings = loadSettings();

  // sync با configuration service (تنظیمات manifest)
  if (context?.services?.configuration) {
    const config = context.services.configuration;
    const c = {
      enabled: config.get('rtlSupport.enabled', currentSettings.enabled),
      mode: config.get<'auto' | 'rtl' | 'ltr'>('rtlSupport.mode', currentSettings.mode),
      threshold: config.get<number>('rtlSupport.threshold', currentSettings.threshold),
      perBlock: config.get<boolean>('rtlSupport.perBlock', currentSettings.perBlock),
      inputRtl: config.get<boolean>('rtlSupport.inputRtl', currentSettings.inputRtl),
      inlineDetect: config.get<boolean>('rtlSupport.inlineDetect', currentSettings.inlineDetect),
      debug: config.get<boolean>('rtlSupport.debug', currentSettings.debug),
    };
    currentSettings = c;
    saveSettings(c);
  }

  // debug flag
  setDebug(currentSettings.debug);

  // input RTL
  if (currentSettings.enabled && currentSettings.inputRtl && typeof document !== 'undefined') {
    startInputRtl(document.body, currentSettings);
  }

  // keyboard shortcut
  registerKeyboardShortcut();

  // runtime API
  registerRuntimeApi();

  if (isDebug()) {
    console.log('[RTL Support] Activated', currentSettings);
  }
}

/** میانبر صفحه‌کلید: Ctrl+Shift+R برای toggle */
function registerKeyboardShortcut(): void {
  if (typeof document === 'undefined') return;

  const handler = (e: KeyboardEvent) => {
    // Ctrl+Shift+R (یا Cmd+Shift+R روی mac)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      const api = (globalThis as Record<string, unknown>).nimbalystRtlSupport as {
        toggle: () => boolean;
      } | undefined;
      if (api) {
        const enabled = api.toggle();
        console.log(`[RTL Support] ${enabled ? 'enabled' : 'disabled'} via shortcut`);
      }
    }
  };

  document.addEventListener('keydown', handler);

  // cleanup registration برای deactivate
  if (currentSettings) {
    const origDeactivate = deactivate;
    // ذخیره handler برای cleanup — در deactivate پاک می‌شه
    (globalThis as Record<string, unknown>)['__rtlShortcutHandler'] = handler;
    void origDeactivate;
  }
}

function registerRuntimeApi(): void {
  const api = {
    getSettings: (): RtlSettings => ({ ...currentSettings }),
    updateSettings: (next: Partial<RtlSettings>): RtlSettings => {
      const merged = { ...currentSettings, ...next };
      saveSettings(merged);
      currentSettings = merged;
      setDebug(merged.debug);
      return merged;
    },
    reset: (): RtlSettings => {
      const defaults = resetSettings();
      currentSettings = defaults;
      setDebug(defaults.debug);
      return defaults;
    },
    enable: (): void => { api.updateSettings({ enabled: true }); },
    disable: (): void => { api.updateSettings({ enabled: false }); },
    toggle: (): boolean => {
      const next = !currentSettings.enabled;
      api.updateSettings({ enabled: next });
      return next;
    },
  };

  (globalThis as Record<string, unknown>)['nimbalystRtlSupport'] = api;
}

export function deactivate(): void {
  // keyboard shortcut cleanup
  const handler = (globalThis as Record<string, unknown>)['__rtlShortcutHandler'];
  if (typeof handler === 'function' && typeof document !== 'undefined') {
    document.removeEventListener('keydown', handler as EventListener);
    delete (globalThis as Record<string, unknown>)['__rtlShortcutHandler'];
  }

  stopInputRtl();
  delete (globalThis as Record<string, unknown>).nimbalystRtlSupport;
}
