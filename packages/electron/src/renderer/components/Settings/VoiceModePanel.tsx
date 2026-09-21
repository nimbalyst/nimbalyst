/**
 * Voice Mode Settings Panel
 *
 * Self-contained component that subscribes directly to Jotai atoms.
 * No props needed - settings are read from and written to atoms.
 */

import React from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  voiceModeSettingsAtom,
  setVoiceModeSettingsAtom,
  apiKeysAtom,
  setApiKeyAtom,
  defaultAgentModelAtom,
  type VoiceModeSettings,
  type VoiceId,
  type RealtimeModel,
  type RealtimeReasoningEffort,
  type TurnDetectionConfig,
  type SystemPromptConfig,
  type VoiceEngineSetting,
} from '../../store/atoms/appSettings';
import { liveVoicePreviews } from './liveVoicePreviews';
import { useVoicePreview } from './useVoicePreview';
import { previewEligibility, resolveVoiceForEngine, voiceGroupsForEngine } from './voiceEngineOptions';
import { useRemoteVoicePreview } from './useRemoteVoicePreview';
import { addSessionFullAtom, setSelectedWorkstreamAtom, setWindowModeAtom, navigateToSettingsAtom } from '../../store';
import { useDialog } from '../../contexts/DialogContext';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { buildVoiceProjectSummaryPrompt, VOICE_PROJECT_SUMMARY_PATH } from './voiceModeSummaryPrompt';
import type { SessionCreateResult } from '../../../shared/ipc/types';

interface VoiceModePanelProps {
  /** Optional workspace path for project-specific features like summary generation */
  workspacePath?: string;
}

// Default turn detection config
const DEFAULT_TURN_DETECTION: TurnDetectionConfig = {
  mode: 'server_vad',
  vadThreshold: 0.5,
  silenceDuration: 500,
  interruptible: true,
};

type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export const VoiceModePanel: React.FC<VoiceModePanelProps> = ({
  workspacePath,
}) => {
  // Subscribe to atoms directly - no props needed
  const [voiceModeSettings] = useAtom(voiceModeSettingsAtom);
  const [, updateVoiceModeSettings] = useAtom(setVoiceModeSettingsAtom);
  const apiKeys = useAtomValue(apiKeysAtom);
  const [, setApiKey] = useAtom(setApiKeyAtom);
  const defaultAgentModel = useAtomValue(defaultAgentModelAtom);
  const addSession = useSetAtom(addSessionFullAtom);
  const setSelectedWorkstream = useSetAtom(setSelectedWorkstreamAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const navigateToSettings = useSetAtom(navigateToSettingsAtom);
  const dialog = useDialog();
  const hasAgentConfigured = !!defaultAgentModel?.trim();

  // Extract values from atom
  const {
    enabled,
    engine,
    voice,
    model,
    reasoningEffort,
    turnDetection,
    voiceAgentPrompt,
    codingAgentPrompt,
    submitDelayMs,
    listenWindowMs,
  } = voiceModeSettings;

  // Check if OpenAI key is configured
  const hasOpenAIKey = !!apiKeys.openai;

  const activeEngine: VoiceEngineSetting = engine ?? 'live';
  const voiceGroups = React.useMemo(() => voiceGroupsForEngine(activeEngine), [activeEngine]);
  const effectiveVoice = resolveVoiceForEngine(activeEngine, voice);
  const preview = previewEligibility(activeEngine, effectiveVoice);

  // Handler to update any voice mode setting
  const handleSettingChange = React.useCallback((updates: Partial<VoiceModeSettings>) => {
    updateVoiceModeSettings(updates);
  }, [updateVoiceModeSettings]);

  const [showVoiceAgentPrompt, setShowVoiceAgentPrompt] = React.useState(false);
  const [showCodingAgentPrompt, setShowCodingAgentPrompt] = React.useState(false);
  const localPreview = useVoicePreview(activeEngine === 'live' ? liveVoicePreviews[effectiveVoice] : undefined);
  const remotePreview = useRemoteVoicePreview(activeEngine !== 'live', effectiveVoice);
  const isPreviewPlaying = activeEngine === 'live' ? localPreview.isPlaying : remotePreview.isPlaying;

  // Project summary state. Generation now happens inside an agent session, so
  // there's no in-panel spinner -- we only track whether the file exists on
  // disk and surface failure messages from the launch path.
  const [projectSummaryExists, setProjectSummaryExists] = React.useState<boolean | null>(null);
  const [summaryError, setSummaryError] = React.useState<string | null>(null);
  const [summaryPath, setSummaryPath] = React.useState<string | null>(null);

  // Microphone access state. Only populated while voice mode is enabled --
  // we don't probe the OS at all when voice is off, so a user who never opts
  // in never has the mic permission concept surfaced.
  const [micStatus, setMicStatus] = React.useState<MicAccessStatus | null>(null);
  const [micPlatform, setMicPlatform] = React.useState<NodeJS.Platform | null>(null);

  const checkMicStatus = React.useCallback(async () => {
    try {
      const result = await window.electronAPI?.invoke('voice-mode:get-mic-status') as
        | { status: MicAccessStatus; platform: NodeJS.Platform }
        | undefined;
      if (result) {
        setMicStatus(result.status);
        setMicPlatform(result.platform);
      }
    } catch {
      setMicStatus(null);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      setMicStatus(null);
      return;
    }
    checkMicStatus();
  }, [enabled, checkMicStatus]);

  const handleOpenMicSettings = async () => {
    await window.electronAPI?.invoke('voice-mode:open-mic-settings');
  };

  // Check if project summary exists
  React.useEffect(() => {
    if (!workspacePath) {
      setProjectSummaryExists(null);
      return;
    }

    const checkSummary = async () => {
      try {
        const path = `${workspacePath}/${VOICE_PROJECT_SUMMARY_PATH}`;
        const exists = await window.electronAPI?.invoke('file:exists', path);
        setProjectSummaryExists(exists);
        if (exists) {
          setSummaryPath(path);
        }
      } catch {
        setProjectSummaryExists(false);
      }
    };

    checkSummary();
  }, [workspacePath]);

  // Launch an agent session that generates the voice-mode project summary.
  // The agent reads project files itself and writes the summary to
  // nimbalyst-local/voice-project-summary.md via its Write tool. Voice mode
  // picks up the file on next session start (see VoiceModeService.ts loadSessionContext).
  const handleGenerateSummary = async () => {
    if (!workspacePath || !window.electronAPI) return;
    if (!hasAgentConfigured) return;

    setSummaryError(null);

    const parsed = ModelIdentifier.tryParse(defaultAgentModel);
    const provider = parsed?.provider || 'claude-code';

    const confirmed = await dialog.confirm({
      title: 'Generate project summary?',
      message:
        `This will launch a new AI session using ${defaultAgentModel}. ` +
        `The session will read your project files and write a voice-friendly ` +
        `summary to ${VOICE_PROJECT_SUMMARY_PATH}, which voice mode uses for ` +
        `context. You'll be taken to the session so you can watch it run.`,
      confirmLabel: 'Launch session',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    try {
      const sessionId = crypto.randomUUID();
      const title = 'Voice mode: project summary';
      const result: SessionCreateResult = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultAgentModel,
          title,
        },
        workspaceId: workspacePath,
      });

      if (!result?.success || !result.id) {
        setSummaryError(result?.error || 'Failed to create agent session');
        return;
      }

      addSession({
        id: result.id,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider,
        model: defaultAgentModel,
        sessionType: 'session',
        messageCount: 0,
        workspaceId: workspacePath,
        isArchived: false,
        isPinned: false,
        parentSessionId: null,
        worktreeId: null,
        childCount: 0,
        uncommittedCount: 0,
      });

      // Send the first message -- this kicks off agent execution.
      await window.electronAPI.invoke(
        'ai:sendMessage',
        buildVoiceProjectSummaryPrompt(),
        undefined,
        result.id,
        workspacePath,
      );

      // Switch to Agent mode and select the new session so the user can watch it run.
      // Switching modes implicitly unmounts the Settings view -- no explicit close needed.
      setWindowMode('agent');
      setSelectedWorkstream({
        workspacePath,
        selection: { type: 'session', id: result.id },
      });
    } catch (error) {
      console.error('[VoiceModePanel] Failed to launch summary session:', error);
      setSummaryError(error instanceof Error ? error.message : 'Failed to launch summary session');
    }
  };

  // Open summary file in editor
  const handleOpenSummary = async () => {
    if (summaryPath && workspacePath) {
      await window.electronAPI?.invoke('workspace:open-file', { workspacePath, filePath: summaryPath });
    }
  };

  // Toggle voice mode. We no longer auto-launch a summary session here --
  // generating the summary spawns a visible agent session that costs tokens,
  // so it must be an explicit user action.
  const handleEnabledChange = (newEnabled: boolean) => {
    handleSettingChange({ enabled: newEnabled });
  };

  // Use defaults for turn detection
  const currentTurnDetection = { ...DEFAULT_TURN_DETECTION, ...turnDetection };

  const handleTurnDetectionChange = (updates: Partial<TurnDetectionConfig>) => {
    handleSettingChange({ turnDetection: { ...currentTurnDetection, ...updates } });
  };

  // Switching engines carries the voice over only if the target engine accepts
  // it; otherwise the stored voice is corrected now rather than failing at
  // connect time.
  const handleModelChange = (nextModel: 'gpt-live-1' | RealtimeModel) => {
    const nextEngine: VoiceEngineSetting = nextModel === 'gpt-live-1' ? 'live' : 'realtime';
    const nextVoice = resolveVoiceForEngine(nextEngine, voice);
    handleSettingChange({
      engine: nextEngine,
      ...(nextModel === 'gpt-live-1' ? {} : { model: nextModel }),
      ...(nextVoice === voice ? {} : { voice: nextVoice as VoiceId }),
    });
  };

  const handlePreviewVoice = activeEngine === 'live' ? localPreview.toggle : remotePreview.toggle;
  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Voice Mode
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Use OpenAI's Advanced Voice Mode to control Claude Code with your voice.
          Speak naturally to give commands, and receive spoken responses.
        </p>
      </div>

      <div className="provider-panel-section mb-6">
        <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Enable Voice Mode</h4>

        <div className="setting-item py-3 mb-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">OpenAI API Key</span>
            <span className="setting-description text-xs text-[var(--nim-text-muted)]">
              Required for Voice Mode. Get one from platform.openai.com.
            </span>
          </div>
          <input
            type="password"
            value={apiKeys.openai || ''}
            onChange={(e) => setApiKey({ keyName: 'openai', value: e.target.value })}
            onFocus={(e) => e.target.select()}
            placeholder="sk-..."
            className="mt-2 w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
          />
        </div>

        <div className="setting-item py-3">
          <label className="setting-label flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleEnabledChange(e.target.checked)}
              className="setting-checkbox mt-1 w-4 h-4 rounded border-[var(--nim-border)] accent-[var(--nim-primary)]"
              disabled={!hasOpenAIKey}
            />
            <div className="setting-text flex flex-col gap-0.5">
              <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Show Voice Mode Button</span>
              <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                Display the microphone button in the AI input area
              </span>
            </div>
          </label>
        </div>
      </div>

      {enabled && hasOpenAIKey && micStatus && micStatus !== 'granted' && (
        <div
          className="voice-mode-mic-permission-warning provider-panel-section mb-6 p-4 rounded border border-[var(--nim-warning)] bg-[var(--nim-bg-secondary)]"
          data-testid="voice-mode-mic-permission-warning"
        >
          <div className="flex items-start gap-3">
            <MaterialSymbol icon="mic_off" size={20} className="mt-0.5 text-[var(--nim-warning)]" />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-[var(--nim-text)] mb-1">Microphone access not granted</h4>
              <p className="text-xs text-[var(--nim-text-muted)] mb-3">
                {micStatus === 'denied'
                  ? `Voice Mode needs microphone access. Enable it in ${micPlatform === 'win32' ? 'Windows Settings' : 'System Settings'}, then re-check below.`
                  : micStatus === 'restricted'
                  ? 'Microphone access is restricted on this device (e.g. by parental controls or MDM). Voice Mode cannot capture audio.'
                  : `Voice Mode needs microphone access. Open ${micPlatform === 'win32' ? 'Windows Settings' : 'System Settings'} to grant it.`}
              </p>
              <div className="flex items-center gap-2">
                {(micPlatform === 'darwin' || micPlatform === 'win32') && (
                  <button
                    onClick={handleOpenMicSettings}
                    className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5"
                    data-testid="voice-mode-open-mic-settings"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                    Open {micPlatform === 'win32' ? 'Windows' : 'System'} Settings
                  </button>
                )}
                <button
                  onClick={checkMicStatus}
                  className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-sm flex items-center gap-1.5"
                  data-testid="voice-mode-recheck-mic"
                >
                  <MaterialSymbol icon="refresh" size={14} />
                  Re-check
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {enabled && hasOpenAIKey && (
        <>
          <div className="provider-panel-section mb-6">
            <div className="setting-item py-3">
              <label htmlFor="voice-model" className="setting-name text-sm font-medium text-[var(--nim-text)]">Voice model</label>
              <p className="setting-description text-xs text-[var(--nim-text-muted)] mt-1">
                The model you talk to. Your coding agent is configured separately.
              </p>
              <select
                id="voice-model"
                value={activeEngine === 'live' ? 'gpt-live-1' : (model ?? 'gpt-realtime-2')}
                onChange={(e) => handleModelChange(e.target.value as 'gpt-live-1' | RealtimeModel)}
                className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                data-testid="voice-mode-model-select"
              >
                <option value="gpt-live-1">gpt-live-1 (default)</option>
                <option value="gpt-realtime-2">gpt-realtime-2</option>
                <option value="gpt-realtime">gpt-realtime</option>
              </select>
              <p className="setting-description text-xs text-[var(--nim-text-muted)] mt-2">
                Changes apply to your next voice connection.
              </p>
            </div>

            {activeEngine === 'realtime' && model !== 'gpt-realtime' && (
              <div className="setting-item py-3">
                <div className="setting-text flex flex-col gap-0.5">
                  <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Reasoning Effort</span>
                  <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                    Higher = smarter but slower and more expensive. Low is recommended for a responsive voice relay. Applies to gpt-realtime-2.
                  </span>
                </div>
                <select
                  value={reasoningEffort ?? 'low'}
                  onChange={(e) => handleSettingChange({ reasoningEffort: e.target.value as RealtimeReasoningEffort })}
                  className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                  data-testid="voice-mode-reasoning-effort-select"
                >
                  <option value="minimal">Minimal (fastest)</option>
                  <option value="low">Low (recommended)</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high (slowest, smartest)</option>
                </select>
              </div>

            )}
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Voice Settings</h4>

            <div className="setting-item py-3">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Voice</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  Choose the voice for the assistant. Each voice has its own personality and tone.
                </span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={effectiveVoice}
                  onChange={(e) => handleSettingChange({ voice: e.target.value as VoiceId })}
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                  data-testid="voice-mode-voice-select"
                >
                  {voiceGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} - {v.description}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={handlePreviewVoice}
                  disabled={!preview.canPreview || (activeEngine !== 'live' && remotePreview.isLoading)}
                  className={`px-3 py-1.5 rounded border border-[var(--nim-border)] cursor-pointer flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isPreviewPlaying
                      ? 'bg-[var(--nim-primary)] text-white'
                      : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]'
                  }`}
                  title={
                    !preview.canPreview
                      ? preview.note
                      : isPreviewPlaying
                        ? 'Stop preview'
                        : 'Preview this voice'
                  }
                  data-testid="voice-mode-preview-voice"
                >
                  <MaterialSymbol icon={isPreviewPlaying ? 'stop' : 'play_arrow'} size={16} />
                  {isPreviewPlaying ? 'Stop' : 'Preview'}
                </button>
              </div>
              <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                {preview.canPreview
                  ? activeEngine === 'live'
                    ? 'Preview plays a recording of this GPT Live voice.'
                    : "Preview plays a short sample using OpenAI's text-to-speech service."
                  : preview.note}
                {preview.canPreview && preview.note && <span> {preview.note}</span>}
                {activeEngine === 'live' && localPreview.error && <span role="alert"> {localPreview.error}</span>}
              </p>
            </div>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Turn Detection</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-4">
              Control how the assistant detects when you're speaking and when you're done.
            </p>

            {/* Mode Selection */}
            <div className="setting-item py-3 mb-4">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Input Mode</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  Choose how voice input is captured
                </span>
              </div>
              <select
                value={currentTurnDetection.mode}
                onChange={(e) => handleTurnDetectionChange({ mode: e.target.value as 'server_vad' | 'push_to_talk' })}
                className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
              >
                <option value="server_vad">Voice Activity Detection (automatic)</option>
                <option value="push_to_talk">Push to Talk (hold button)</option>
              </select>
            </div>

            {/* VAD-specific settings */}
            {currentTurnDetection.mode === 'server_vad' && (
              <>
                {/* VAD Threshold */}
                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Voice Detection Sensitivity</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      How sensitive the microphone is to your voice. Lower = more sensitive (picks up quiet speech), Higher = less sensitive (requires louder speech).
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[var(--nim-text-muted)]">Sensitive</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={(currentTurnDetection.vadThreshold || 0.5) * 100}
                      onChange={(e) => handleTurnDetectionChange({ vadThreshold: parseInt(e.target.value) / 100 })}
                      className="flex-1"
                    />
                    <span className="text-xs text-[var(--nim-text-muted)]">Less sensitive</span>
                    <span className="text-xs text-[var(--nim-text)] min-w-[36px]">
                      {Math.round((currentTurnDetection.vadThreshold || 0.5) * 100)}%
                    </span>
                  </div>
                </div>

                {/* Silence Duration */}
                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Pause Before Processing</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      How long to wait after you stop speaking before processing your request. Shorter = faster response, Longer = more time for natural pauses.
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[var(--nim-text-muted)]">Faster</span>
                    <input
                      type="range"
                      min="200"
                      max="1500"
                      step="100"
                      value={currentTurnDetection.silenceDuration || 500}
                      onChange={(e) => handleTurnDetectionChange({ silenceDuration: parseInt(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-xs text-[var(--nim-text-muted)]">Slower</span>
                    <span className="text-xs text-[var(--nim-text)] min-w-[50px]">
                      {((currentTurnDetection.silenceDuration || 500) / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Interruptible setting */}
            <div className="setting-item py-3">
              <label className="setting-label flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={currentTurnDetection.interruptible !== false}
                  onChange={(e) => handleTurnDetectionChange({ interruptible: e.target.checked })}
                  className="setting-checkbox mt-1 w-4 h-4 rounded border-[var(--nim-border)] accent-[var(--nim-primary)]"
                />
                <div className="setting-text flex flex-col gap-0.5">
                  <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Allow Interruptions</span>
                  <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                    You can interrupt the assistant while it's speaking by starting to talk
                  </span>
                </div>
              </label>
            </div>

            {/* Listen Window Duration */}
            <div className="setting-item py-3">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Listen Window Duration</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  How long to keep listening after you stop speaking. After this time, the mic goes to sleep until the assistant responds or you click the mic button.
                </span>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-[var(--nim-text-muted)]">5s</span>
                <input
                  type="range"
                  min="5000"
                  max="30000"
                  step="1000"
                  value={listenWindowMs ?? 15000}
                  onChange={(e) => handleSettingChange({ listenWindowMs: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-xs text-[var(--nim-text-muted)]">30s</span>
                <span className="text-xs text-[var(--nim-text)] min-w-[36px]">
                  {Math.round((listenWindowMs ?? 15000) / 1000)}s
                </span>
              </div>
            </div>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Command Submission</h4>

            {/* Submit Delay */}
            <div className="setting-item py-3 mb-4">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Review Delay Before Submitting</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  Time to review and edit voice commands before they're sent to the coding agent. Set to 0 for immediate submission.
                </span>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-[var(--nim-text-muted)]">Immediate</span>
                <input
                  type="range"
                  min="0"
                  max="10000"
                  step="500"
                  value={submitDelayMs ?? 3000}
                  onChange={(e) => handleSettingChange({ submitDelayMs: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-xs text-[var(--nim-text-muted)]">10 seconds</span>
                <span className="text-xs text-[var(--nim-text)] min-w-[50px]">
                  {((submitDelayMs ?? 3000) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          </div>

          {/* Project Summary Section */}
          {workspacePath && (
            <div className="voice-mode-project-summary provider-panel-section mb-6">
              <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Project Summary</h4>
              <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                The voice assistant uses an AI-generated summary of your project to understand context.
                Stored in <code className="text-xs bg-[var(--nim-bg-secondary)] px-1 py-0.5 rounded">{VOICE_PROJECT_SUMMARY_PATH}</code>.
              </p>

              {projectSummaryExists ? (
                <div className="flex items-center gap-2">
                  <MaterialSymbol icon="check_circle" size={16} className="text-[var(--nim-success)]" />
                  <span className="text-[var(--nim-text-muted)]">Summary exists</span>
                  <button
                    onClick={handleOpenSummary}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1"
                    title="Open summary file"
                    data-testid="voice-mode-summary-view"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                    View
                  </button>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={!hasAgentConfigured}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={hasAgentConfigured ? 'Regenerate summary' : 'Configure an agent to enable regeneration'}
                    data-testid="voice-mode-summary-regenerate"
                  >
                    <MaterialSymbol icon="refresh" size={14} />
                    Regenerate
                  </button>
                </div>
              ) : (
                <div>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={!hasAgentConfigured}
                    className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="voice-mode-summary-generate"
                  >
                    <MaterialSymbol icon="auto_awesome" size={16} />
                    Generate Project Summary
                  </button>
                  <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                    Launches an agent session that reads your project and writes the summary file. You'll
                    be taken to the session so you can watch it work.
                  </p>
                </div>
              )}

              {!hasAgentConfigured && (
                <p className="mt-3 text-xs text-[var(--nim-text-muted)]" data-testid="voice-mode-summary-no-agent">
                  No agent is configured.{' '}
                  <button
                    type="button"
                    onClick={() => navigateToSettings({ category: 'claude-code' })}
                    className="bg-transparent border-none p-0 cursor-pointer text-[var(--nim-primary)] underline"
                  >
                    Configure one in AI Models settings
                  </button>{' '}
                  to enable this.
                </p>
              )}

              {summaryError && (
                <p className="mt-2 text-xs text-[var(--nim-error)]" data-testid="voice-mode-summary-error">
                  {summaryError}
                </p>
              )}
            </div>
          )}

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Usage & Pricing</h4>
            {activeEngine === 'live' ? (
              <>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  GPT-Live is billed per second of connected session time, not per token:
                </p>
                <ul className="ml-5 mt-2 mb-2 text-sm text-[var(--nim-text-muted)] list-disc">
                  <li>Voice session: $0.05 per minute connected</li>
                  <li>Billing continues during silence and while a task runs; closing the session stops it</li>
                  <li>The delegated controller model is billed separately, on its own rates</li>
                </ul>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  Example: 10 connected minutes is $0.50 of voice time, before controller and coding-agent costs.
                </p>
              </>
            ) : (
              <>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  Realtime is billed per token, so cost follows how much is spoken:
                </p>
                <ul className="ml-5 mt-2 mb-2 text-sm text-[var(--nim-text-muted)] list-disc">
                  <li>Audio input: about $0.02 per minute you speak</li>
                  <li>Audio output: about $0.08 per minute the assistant speaks</li>
                  <li>Plus transcription and text/history tokens</li>
                </ul>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  Example: 10 minutes with each side speaking 5 is roughly $0.50, before coding-agent costs.
                </p>
              </>
            )}
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">How It Works</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
              Voice Mode uses {activeEngine === 'live' ? 'GPT-Live' : 'GPT Realtime'} as an intelligent
              voice interface to your coding agent. You speak your coding requests naturally,
              and the voice assistant translates them into agent commands.
            </p>
            <p className="provider-panel-hint mt-2 text-sm text-[var(--nim-text-muted)]">
              When Claude Code finishes working, the assistant summarizes what was done
              and speaks it back to you.
            </p>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">System Prompt Customization</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-4">
              Customize the behavior of the voice agent and coding agent during voice mode sessions.
            </p>

            {/* Voice Agent Prompt Section */}
            <button
              onClick={() => setShowVoiceAgentPrompt(!showVoiceAgentPrompt)}
              className={`flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer text-[var(--nim-text)] text-sm font-medium ${showVoiceAgentPrompt ? 'mb-3' : 'mb-4'}`}
            >
              <MaterialSymbol icon={showVoiceAgentPrompt ? 'expand_less' : 'expand_more'} size={20} />
              Voice Agent Instructions
            </button>

            {showVoiceAgentPrompt && (
              <div className="mb-6 pl-7">
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                  Customize the voice assistant (GPT-4 Realtime) that handles speech interaction.
                </p>

                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Prepend to Instructions</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      Added before the default voice assistant instructions
                    </span>
                  </div>
                  <textarea
                    value={voiceAgentPrompt?.prepend || ''}
                    onChange={(e) => handleSettingChange({
                      voiceAgentPrompt: {
                        ...voiceAgentPrompt,
                        prepend: e.target.value,
                      },
                    })}
                    placeholder="e.g., Always respond in a formal tone..."
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>

                <div className="setting-item py-3">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Append to Instructions</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      Added after the default voice assistant instructions
                    </span>
                  </div>
                  <textarea
                    value={voiceAgentPrompt?.append || ''}
                    onChange={(e) => handleSettingChange({
                      voiceAgentPrompt: {
                        ...voiceAgentPrompt,
                        append: e.target.value,
                      },
                    })}
                    placeholder="e.g., When discussing code, always mention file names..."
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>
              </div>
            )}

            {/* Coding Agent Prompt Section */}
            <button
              onClick={() => setShowCodingAgentPrompt(!showCodingAgentPrompt)}
              className={`flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer text-[var(--nim-text)] text-sm font-medium ${showCodingAgentPrompt ? 'mb-3' : ''}`}
            >
              <MaterialSymbol icon={showCodingAgentPrompt ? 'expand_less' : 'expand_more'} size={20} />
              Coding Agent Instructions (Voice Mode)
            </button>

            {showCodingAgentPrompt && (
              <div className="pl-7">
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                  Customize the coding agent (Claude) when processing voice mode requests.
                  These instructions are added to the system prompt only during voice mode sessions.
                </p>

                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Prepend to Instructions</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      Added before the coding agent's voice mode context
                    </span>
                  </div>
                  <textarea
                    value={codingAgentPrompt?.prepend || ''}
                    onChange={(e) => handleSettingChange({
                      codingAgentPrompt: {
                        ...codingAgentPrompt,
                        prepend: e.target.value,
                      },
                    })}
                    placeholder="e.g., When responding to voice requests, prioritize brevity..."
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>

                <div className="setting-item py-3">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Append to Instructions</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      Added after the coding agent's voice mode context
                    </span>
                  </div>
                  <textarea
                    value={codingAgentPrompt?.append || ''}
                    onChange={(e) => handleSettingChange({
                      codingAgentPrompt: {
                        ...codingAgentPrompt,
                        append: e.target.value,
                      },
                    })}
                    placeholder="e.g., Always summarize what you did in 1-2 sentences at the end..."
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
