import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { DictationAvailability, DictationEngineSetting } from '../../../shared/dictation';
import { getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import {
  dictationAvailabilityAtom,
  dictationSettingsAtom,
  refreshDictationAvailabilityAtom,
  setDictationSettingsAtom,
} from '../../store/atoms/dictation';
import { DICTATION_SHORTCUT } from '../../dictation/dictationShortcut';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

const ENGINE_OPTIONS: Array<{ value: DictationEngineSetting; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on-device', label: 'On-device (macOS)' },
  { value: 'openai', label: 'OpenAI' },
];

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'System default' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'German' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
];

/** Explain which engine will run, or why none can. */
function describeDictationAvailability(
  engine: DictationEngineSetting,
  availability: DictationAvailability | null,
): { ok: boolean; text: string } | null {
  if (!availability) return null;
  const { onDevice, openai } = availability;
  if (engine === 'on-device') {
    return onDevice
      ? { ok: true, text: 'On-device recognition is available. Audio stays on this Mac.' }
      : { ok: false, text: 'On-device recognition is not available here. It needs macOS with speech recognition support. Choose OpenAI or Auto instead.' };
  }
  if (engine === 'openai') {
    return openai
      ? { ok: true, text: 'Uses your OpenAI API key. Audio is sent to OpenAI and billed to that key.' }
      : { ok: false, text: 'No OpenAI API key is set. Add one under Agent Providers > Saved API keys.' };
  }
  if (onDevice) return { ok: true, text: 'Auto will use on-device recognition. Audio stays on this Mac.' };
  if (openai) return { ok: true, text: 'Auto will use OpenAI with your API key. Audio is sent to OpenAI.' };
  return {
    ok: false,
    text: 'No speech engine is available. On macOS, on-device recognition needs a supported macOS version; elsewhere add an OpenAI API key under Agent Providers > Saved API keys. Your operating system\'s own dictation also works in any text field.',
  };
}

export function DictationPanel() {
  const settings = useAtomValue(dictationSettingsAtom);
  const setSettings = useSetAtom(setDictationSettingsAtom);
  const availability = useAtomValue(dictationAvailabilityAtom);
  const refreshAvailability = useSetAtom(refreshDictationAvailabilityAtom);

  useEffect(() => {
    void refreshAvailability();
  }, [refreshAvailability]);

  const status = describeDictationAvailability(settings.engine, availability);
  const shortcut = getShortcutDisplay(DICTATION_SHORTCUT);

  return (
    <div className="dictation-panel provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">Dictation</h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Speak instead of typing in the agent input and in documents. Words appear at the cursor for you to edit; nothing is sent until you send it. This is separate from Voice Mode.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Dictation"
        description={
          settings.enabled
            ? `Click the microphone button, or hold ${shortcut} to talk. A quick tap keeps it listening until you tap again. Esc discards the unfinished phrase.`
            : 'Off: microphone buttons and the shortcut are hidden everywhere.'
        }
        checked={settings.enabled}
        onChange={(enabled) => void setSettings({ enabled })}
        testId="dictation-enabled-toggle"
      />

      {settings.enabled && (
        <div className="provider-panel-section mb-6 flex flex-col gap-4">
          <div className="setting-item">
            <label htmlFor="dictation-engine" className="setting-name text-sm font-medium text-[var(--nim-text)]">Speech engine</label>
            <select
              id="dictation-engine"
              value={settings.engine}
              onChange={(e) => void setSettings({ engine: e.target.value as DictationEngineSetting })}
              className="mt-2 block px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
              data-testid="dictation-engine-select"
            >
              {ENGINE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {status && (
              <p
                className={`dictation-availability mt-2 text-xs select-text ${status.ok ? 'text-[var(--nim-text-muted)]' : 'text-[var(--nim-warning)]'}`}
                data-testid="dictation-availability"
              >
                {status.text}
              </p>
            )}
          </div>

          <div className="setting-item">
            <label htmlFor="dictation-language" className="setting-name text-sm font-medium text-[var(--nim-text)]">Language</label>
            <select
              id="dictation-language"
              value={settings.language ?? ''}
              // '' clears the saved language (main drops empty values)
              onChange={(e) => void setSettings({ language: e.target.value })}
              className="mt-2 block px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
              data-testid="dictation-language-select"
            >
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              {settings.language && !LANGUAGE_OPTIONS.some((o) => o.value === settings.language) && (
                <option value={settings.language}>{settings.language}</option>
              )}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
