/**
 * Voice Mode Settings Panel
 *
 * Self-contained component that subscribes directly to Jotai atoms.
 * No props needed - settings are read from and written to atoms.
 */

import React from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  voiceModeSettingsAtom,
  setVoiceModeSettingsAtom,
  apiKeysAtom,
  setApiKeyAtom,
  type VoiceModeSettings,
  type VoiceId,
  type TurnDetectionConfig,
  type SystemPromptConfig,
} from '../../store/atoms/appSettings';
import { voiceModePreviewAudioAtom } from '../../store/atoms/voiceModeState';
import { AlphaBadge } from '../common/AlphaBadge';

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

// Available OpenAI Realtime API voices with descriptions
// Some voices are Realtime-only and use approximations for TTS preview
// Gender categorization based on OpenAI documentation and community observations
const VOICE_OPTIONS: Array<{
  id: string;
  name: string;
  description: string;
  gender: 'male' | 'female' | 'neutral';
  realtimeOnly?: boolean; // If true, preview uses a similar voice approximation
}> = [
  // Male voices
  { id: 'ash', name: 'Ash', description: 'Clear and confident', gender: 'male' },
  { id: 'echo', name: 'Echo', description: 'Smooth and resonant', gender: 'male' },
  { id: 'verse', name: 'Verse', description: 'Dynamic and engaging', gender: 'male', realtimeOnly: true },
  { id: 'cedar', name: 'Cedar', description: 'Deep and authoritative', gender: 'male', realtimeOnly: true },
  // Female voices
  { id: 'coral', name: 'Coral', description: 'Warm and friendly', gender: 'female' },
  { id: 'sage', name: 'Sage', description: 'Thoughtful and calm', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', description: 'Bright and cheerful', gender: 'female' },
  { id: 'ballad', name: 'Ballad', description: 'Melodic and expressive', gender: 'female', realtimeOnly: true },
  { id: 'marin', name: 'Marin', description: 'Natural and conversational', gender: 'female', realtimeOnly: true },
  // Neutral voices
  { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile', gender: 'neutral' },
];

// Group voices by gender for the dropdown
const VOICE_GROUPS = [
  { label: 'Male', voices: VOICE_OPTIONS.filter(v => v.gender === 'male') },
  { label: 'Female', voices: VOICE_OPTIONS.filter(v => v.gender === 'female') },
  { label: 'Neutral', voices: VOICE_OPTIONS.filter(v => v.gender === 'neutral') },
];

export const VoiceModePanel: React.FC<VoiceModePanelProps> = ({
  workspacePath,
}) => {
  // Subscribe to atoms directly - no props needed
  const [voiceModeSettings] = useAtom(voiceModeSettingsAtom);
  const [, updateVoiceModeSettings] = useAtom(setVoiceModeSettingsAtom);
  const apiKeys = useAtomValue(apiKeysAtom);
  const [, setApiKey] = useAtom(setApiKeyAtom);

  // Extract values from atom
  const {
    enabled,
    voice,
    turnDetection,
    voiceAgentPrompt,
    codingAgentPrompt,
    submitDelayMs,
    listenWindowMs,
  } = voiceModeSettings;

  // Check if OpenAI key is configured
  const hasOpenAIKey = !!apiKeys.openai;

  // Handler to update any voice mode setting
  const handleSettingChange = React.useCallback((updates: Partial<VoiceModeSettings>) => {
    updateVoiceModeSettings(updates);
  }, [updateVoiceModeSettings]);

  const [showVoiceAgentPrompt, setShowVoiceAgentPrompt] = React.useState(false);
  const [showCodingAgentPrompt, setShowCodingAgentPrompt] = React.useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Project summary state
  const [projectSummaryExists, setProjectSummaryExists] = React.useState<boolean | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = React.useState(false);
  const [summaryError, setSummaryError] = React.useState<string | null>(null);
  const [summaryPath, setSummaryPath] = React.useState<string | null>(null);

  // Check if project summary exists
  React.useEffect(() => {
    if (!workspacePath) {
      setProjectSummaryExists(null);
      return;
    }

    const checkSummary = async () => {
      try {
        const path = `${workspacePath}/nimbalyst-local/voice-project-summary.md`;
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

  // Generate project summary
  const handleGenerateSummary = async () => {
    if (!workspacePath) return;

    setIsGeneratingSummary(true);
    setSummaryError(null);

    try {
      const result = await window.electronAPI?.invoke('voice-mode:generate-project-summary', workspacePath);
      if (result?.success) {
        setProjectSummaryExists(true);
        setSummaryPath(result.path);
      } else {
        setSummaryError(result?.message || 'Failed to generate summary');
      }
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  // Open summary file in editor
  const handleOpenSummary = async () => {
    if (summaryPath && workspacePath) {
      await window.electronAPI?.invoke('workspace:open-file', { workspacePath, filePath: summaryPath });
    }
  };

  // Auto-generate summary when voice mode is first enabled
  const handleEnabledChange = async (newEnabled: boolean) => {
    handleSettingChange({ enabled: newEnabled });

    // If enabling voice mode and no summary exists, generate one
    if (newEnabled && workspacePath && projectSummaryExists === false) {
      handleGenerateSummary();
    }
  };

  // Listen for preview audio from main process
  // Stop any playing audio on unmount.
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Play preview audio when main process broadcasts a `voice-mode:preview-audio`
  // event. The IPC event is handled centrally in
  // store/listeners/voiceModeListeners.ts which writes voiceModePreviewAudioAtom;
  // we play only on *new* bumps so any audio that was queued up before this
  // panel mounted doesn't replay on open.
  const previewAudio = useAtomValue(voiceModePreviewAudioAtom);
  const initialPreviewAudioRef = React.useRef(previewAudio);
  React.useEffect(() => {
    if (previewAudio === initialPreviewAudioRef.current) return;
    if (!previewAudio) return;
    const { audioBase64, format } = previewAudio.payload;
    const audio = new Audio(`data:audio/${format};base64,${audioBase64}`);
    audioRef.current = audio;
    setIsPreviewPlaying(true);

    audio.onended = () => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    };

    audio.onerror = () => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    };

    audio.play().catch(() => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    });
  }, [previewAudio]);

  // Use defaults for turn detection
  const currentTurnDetection = { ...DEFAULT_TURN_DETECTION, ...turnDetection };

  const handleTurnDetectionChange = (updates: Partial<TurnDetectionConfig>) => {
    handleSettingChange({ turnDetection: { ...currentTurnDetection, ...updates } });
  };

  const handlePreviewVoice = async () => {
    if (isPreviewPlaying) {
      // Stop current preview
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPreviewPlaying(false);
      return;
    }

    setIsPreviewPlaying(true);
    try {
      const result = await window.electronAPI?.invoke('voice-mode:preview-voice', voice);
      if (!result?.success) {
        console.error('[VoiceModePanel] Preview failed:', result?.message);
        setIsPreviewPlaying(false);
      }
      // Audio will be received via IPC and played automatically
    } catch (error) {
      console.error('[VoiceModePanel] Preview error:', error);
      setIsPreviewPlaying(false);
    }
  };
  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Voice Mode
          <AlphaBadge size="sm" />
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

      {enabled && hasOpenAIKey && (
        <>
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
                  value={voice}
                  onChange={(e) => handleSettingChange({ voice: e.target.value as VoiceId })}
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                >
                  {VOICE_GROUPS.map((group) => (
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
                  disabled={isPreviewPlaying && !audioRef.current}
                  className={`px-3 py-1.5 rounded border border-[var(--nim-border)] cursor-pointer flex items-center gap-1 ${
                    isPreviewPlaying
                      ? 'bg-[var(--nim-primary)] text-white'
                      : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]'
                  }`}
                  title={isPreviewPlaying ? 'Stop preview' : 'Preview this voice'}
                >
                  <MaterialSymbol icon={isPreviewPlaying ? 'stop' : 'play_arrow'} size={16} />
                  {isPreviewPlaying ? 'Stop' : 'Preview'}
                </button>
              </div>
              <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                Preview plays a short sample using OpenAI's TTS API.
                {VOICE_OPTIONS.find(v => v.id === voice)?.realtimeOnly && (
                  <span className="text-[var(--nim-text-muted)]">
                    {' '}This voice is Realtime-only; preview uses a similar voice.
                  </span>
                )}
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
            <div className="provider-panel-section mb-6">
              <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Project Summary</h4>
              <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                The voice assistant uses an AI-generated summary of your project to understand context.
                This summary is stored in <code className="text-xs bg-[var(--nim-bg-secondary)] px-1 py-0.5 rounded">nimbalyst-local/voice-project-summary.md</code>.
              </p>

              {isGeneratingSummary ? (
                <div className="flex items-center gap-2 text-[var(--nim-text-muted)]">
                  <MaterialSymbol icon="sync" size={16} className="animate-spin" />
                  Generating project summary using Claude...
                </div>
              ) : projectSummaryExists ? (
                <div className="flex items-center gap-2">
                  <MaterialSymbol icon="check_circle" size={16} className="text-[var(--nim-success)]" />
                  <span className="text-[var(--nim-text-muted)]">Summary exists</span>
                  <button
                    onClick={handleOpenSummary}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1"
                    title="Open summary file"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                    View
                  </button>
                  <button
                    onClick={handleGenerateSummary}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1"
                    title="Regenerate summary"
                  >
                    <MaterialSymbol icon="refresh" size={14} />
                    Regenerate
                  </button>
                </div>
              ) : (
                <div>
                  <button
                    onClick={handleGenerateSummary}
                    className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5"
                  >
                    <MaterialSymbol icon="auto_awesome" size={16} />
                    Generate Project Summary
                  </button>
                  <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                    This will read your CLAUDE.md, README.md, and package.json to create a concise summary.
                  </p>
                </div>
              )}

              {summaryError && (
                <p className="mt-2 text-xs text-[var(--nim-error)]">
                  {summaryError}
                </p>
              )}
            </div>
          )}

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">Usage & Pricing</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
              OpenAI charges for voice mode usage:
            </p>
            <ul className="ml-5 mt-2 mb-2 text-sm text-[var(--nim-text-muted)] list-disc">
              <li>Audio Input: $0.06 per minute</li>
              <li>Audio Output: $0.24 per minute</li>
              <li>Plus standard token costs for processing</li>
            </ul>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
              Example: A 5-minute conversation costs approximately $0.50
            </p>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">How It Works</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
              Voice Mode uses OpenAI's Advanced Voice Mode (GPT Realtime) as an intelligent
              voice interface to Claude Code. You speak your coding requests naturally,
              and the voice assistant translates them into Claude Code commands.
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
