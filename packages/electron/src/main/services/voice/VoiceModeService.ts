/**
 * Voice Mode Service - manages voice mode sessions and integrates with OpenAI Realtime API
 */

import { BrowserWindow, ipcMain, systemPreferences } from 'electron';
import { RealtimeAPIClient, BUILTIN_VOICE_TOOL_NAMES, type RealtimeModel, type RealtimeReasoningEffort } from './RealtimeAPIClient';
import { buildVoiceToolSet } from './voiceToolBridge';
import { mapAiSessionStatusToTaskStatus } from './taskStatus';
import {
  getVoiceEnabledExtensionTools,
  getVoiceEnabledBackendToolsForWorkspace,
  resolveBackendWorkspacePath,
} from '../../mcp/mcpWorkspaceResolver';
import { handleExtensionTool } from '../../mcp/tools/extensionToolHandler';
import { handleBackendTool, isBackendTool } from '../../mcp/tools/backendToolHandler';
import { safeHandle } from '../../utils/ipcRegistry';
import Store from 'electron-store';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { searchSessionsForVoice } from './sessionSearch';
import { getSessionSummaryForVoice } from './sessionSummary';
import { getDatabase } from '../../database/initialize';
import { getDefaultAIModel, getPreferredAgentLanguage } from '../../utils/store';
import { randomUUID } from 'crypto';

// Store active voice session info
interface VoiceSession {
  poc: RealtimeAPIClient;
  window: BrowserWindow;
  workspacePath: string | null;
  sessionId: string;
  cleanupCompletionListener: () => void;
  startTime: number; // For duration tracking
  hasExistingSession: boolean; // Whether AI session had prior messages
}

/**
 * Get duration category for analytics (privacy-preserving)
 */
function getDurationCategory(durationMs: number): 'short' | 'medium' | 'long' {
  if (durationMs < 60000) return 'short'; // < 1 minute
  if (durationMs < 300000) return 'medium'; // 1-5 minutes
  return 'long'; // > 5 minutes
}

/**
 * Send voice session ended analytics event
 */
function sendSessionEndedEvent(reason: string, startTime: number): void {
  const durationMs = Date.now() - startTime;
  AnalyticsService.getInstance().sendEvent('voice_session_ended', {
    reason,
    durationCategory: getDurationCategory(durationMs),
  });
}

let activeVoiceSession: VoiceSession | null = null;

/**
 * Request the concatenated voice session context contributed by extensions
 * (Core hook 2). Extension providers run in the renderer, so we send a request
 * with a one-shot result channel and await the reply (capped timeout). Returns
 * an empty string if no providers contribute or on timeout/error.
 */
function requestExtensionVoiceContext(
  window: BrowserWindow,
  input: { workspacePath?: string; activeFilePath?: string; voiceSessionId?: string; codingSessionId?: string }
): Promise<string> {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed()) {
      resolve('');
      return;
    }
    const resultChannel = `voice-mode:extension-context-result-${Date.now()}-${Math.random()}`;
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(resultChannel);
      resolve('');
    }, 5000);
    ipcMain.once(resultChannel, (_event, data: { context?: string }) => {
      clearTimeout(timeout);
      resolve(typeof data?.context === 'string' ? data.context : '');
    });
    window.webContents.send('voice-mode:collect-extension-context', { input, resultChannel });
  });
}

/**
 * Check if voice mode is active for a given session
 */
export function isVoiceModeActive(sessionId: string): boolean {
  return activeVoiceSession !== null && activeVoiceSession.sessionId === sessionId;
}

/**
 * Get the active voice session ID if one exists
 * Returns null if no voice session is active
 */
export function getActiveVoiceSessionId(): string | null {
  return activeVoiceSession?.sessionId ?? null;
}

/**
 * Send a message to the active voice agent to be spoken aloud
 * Returns true if the message was sent successfully, false if:
 * - No active voice session for this sessionId
 * - Voice agent WebSocket is not connected
 * - Message sending failed
 */
export function sendToVoiceAgent(sessionId: string, message: string): boolean {
  if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
    console.error('[VoiceModeService] No active voice session for sessionId:', sessionId);
    return false;
  }

  // Check if the voice agent is still connected
  if (!activeVoiceSession.poc.isConnected()) {
    console.error('[VoiceModeService] Voice agent WebSocket is not connected');
    return false;
  }

  // Attempt to send the message
  const success = activeVoiceSession.poc.sendUserMessage(message);

  if (!success) {
    console.error('[VoiceModeService] Failed to send message to voice agent');
  }

  return success;
}

/**
 * Stop the active voice session programmatically
 * Called by the AI assistant via MCP tool to end voice mode
 * Returns true if a session was stopped, false if no session was active
 */
export function stopVoiceSession(): boolean {
  if (!activeVoiceSession) {
    console.log('[VoiceModeService] No active voice session to stop');
    return false;
  }

  const sessionId = activeVoiceSession.sessionId;
  console.log('[VoiceModeService] Stopping voice session programmatically:', sessionId);

  // Track session ended (reason: assistant_stopped)
  sendSessionEndedEvent('assistant_stopped', activeVoiceSession.startTime);

  // Get final token usage before disconnecting
  const finalTokenUsage = activeVoiceSession.poc.getTokenUsage();

  // Disconnect from OpenAI
  activeVoiceSession.poc.disconnect('user_stopped');

  // Clean up the completion listener
  activeVoiceSession.cleanupCompletionListener();

  // Notify the renderer that voice mode was stopped, include final token usage for persistence
  if (activeVoiceSession.window && !activeVoiceSession.window.isDestroyed()) {
    activeVoiceSession.window.webContents.send('voice-mode:stopped', {
      sessionId,
      tokenUsage: finalTokenUsage,
    });
  }

  activeVoiceSession = null;

  return true;
}

/**
 * Get a summary of the current AI session
 * Returns session metadata, message counts, and recent activity
 */
export async function getSessionSummary(): Promise<{
  success: boolean;
  summary?: string;
  details?: {
    sessionId: string;
    sessionName: string;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    sessionDurationMinutes: number;
    recentTopics: string[];
  };
  error?: string;
}> {
  if (!activeVoiceSession) {
    return { success: false, error: 'No active voice session' };
  }
  const { sessionId, window, workspacePath } = activeVoiceSession;
  if (!workspacePath) {
    return { success: false, error: 'No workspace path available' };
  }
  // Shared with the mobile voice-tool proxy (mobileVoiceToolHandler) so the iOS
  // agent gets identical summaries -- including for sessions surfaced by the
  // desktop-backed semantic list_sessions that aren't in the phone's local DB.
  return getSessionSummaryForVoice(workspacePath, sessionId, window);
}

export function initVoiceModeService() {
  // Create settings store instance (MUST match AIService store name!)
  const settingsStore = new Store<Record<string, unknown>>({
    name: 'ai-settings',  // Same as AIService!
    watch: true,
  });

  /**
   * Extension SDK: report the status of the agent task the voice agent is
   * currently driving (the session it targets with submit_agent_prompt). Lets an
   * extension voice tool (e.g. the memory extension's get_task_status) answer
   * "is it still running?" verbally. Resolves the active voice-linked session,
   * then reads its live status from ai_sessions (same source as list_sessions).
   */
  safeHandle('extensions:ai-get-task-status', async (_event, _options: { workspacePath?: string }) => {
    const targetId = getActiveVoiceSessionId();
    if (!targetId) return null;
    try {
      const db = getDatabase();
      const { rows } = await db.query<{ id: string; title: string | null; status: string | null }>(
        `SELECT id, title, status FROM ai_sessions WHERE id = $1`,
        [targetId],
      );
      const row = rows[0];
      if (!row) return null;
      return mapAiSessionStatusToTaskStatus(row);
    } catch (error) {
      console.error('[VoiceModeService] get-task-status query failed:', error);
      return null;
    }
  });

  // Voice mode settings store (for voice mode specific settings including custom prompts)
  const voiceModeSettingsStore = new Store<Record<string, unknown>>({
    name: 'nimbalyst-settings',
    watch: true,
  });

  /**
   * Test OpenAI Realtime API connection
   */
  safeHandle('voice-mode:test-connection', async (event, workspacePath: string | null, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      // Check microphone permission on macOS
      if (process.platform === 'darwin') {
        const micStatus = systemPreferences.getMediaAccessStatus('microphone');
        console.log('[VoiceModeService] Microphone access status:', micStatus);

        if (micStatus !== 'granted') {
          // NOTE: We cannot programmatically request microphone permission because
          // the app intentionally omits the audio-input entitlement to prevent
          // permission prompts when Claude Agent SDK spawns subprocesses.
          // Users must manually grant permission in System Settings.
          throw new Error('Microphone access is required for Voice Mode.\n\nPlease manually grant permission:\n1. Open System Settings\n2. Go to Privacy & Security > Microphone\n3. Enable access for Nimbalyst\n4. Try again');
        }
      }

      // If there's an active session, disconnect it first
      if (activeVoiceSession) {
        activeVoiceSession.poc.disconnect();
        activeVoiceSession = null;
      }

      // Get OpenAI API key from settings store
      const apiKeys = settingsStore.get('apiKeys', {}) as Record<string, string>;
      const apiKey = apiKeys['openai'];

      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please add it in Settings.');
      }

      // Store window reference for sending events
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        throw new Error('Could not find window for session');
      }

      // Load session to get context by calling the renderer to fetch it
      let sessionContext = 'New session with no prior messages.';
      let hasExistingSession = false; // For analytics
      try {
        // Request session data from the renderer
        const session = await window.webContents.executeJavaScript(`
          window.electronAPI.invoke('ai:loadSession', ${JSON.stringify(sessionId)}, ${JSON.stringify(workspacePath)}, false)
        `);

        if (session) {
          // session.messages is TranscriptViewMessage[] from the canonical
          // ai_transcript_events table -- discriminated by `type`, not `role`.
          const allEvents = (session.messages || []) as Array<any>;
          const userEvents = allEvents.filter(m => m.type === 'user_message');
          const assistantEvents = allEvents.filter(m => m.type === 'assistant_message');
          const toolEvents = allEvents.filter(m => m.type === 'tool_call');
          const conversationEvents = allEvents.filter(
            m => m.type === 'user_message' || m.type === 'assistant_message'
          );

          const messageCount = conversationEvents.length;
          hasExistingSession = messageCount > 0;
          // Session name is stored in the 'title' field, not 'name'
          const sessionName = session.title || session.name || 'Untitled';
          const userMessageCount = userEvents.length;
          const sessionMode = session.mode || 'agent'; // 'agent' or 'planning'

          // Build context parts
          const contextParts: string[] = [];
          contextParts.push(`Session: "${sessionName}"`);
          contextParts.push(`Mode: ${sessionMode === 'planning' ? 'Planning mode (read-only exploration)' : 'Agent mode (can make changes)'}`);

          if (messageCount === 0) {
            contextParts.push('Status: New session with no messages yet.');
          } else {
            contextParts.push(`Activity: ${userMessageCount} user ${userMessageCount === 1 ? 'prompt' : 'prompts'}, ${assistantEvents.length} assistant responses.`);

            // Extract recent activity (last few tool calls)
            const recentToolCalls = toolEvents.slice(-5).map(m => m.toolCall).filter(Boolean);

            if (recentToolCalls.length > 0) {
              const toolSummary = recentToolCalls.map((tc: any) => {
                const name = tc.toolName;
                if (name === 'Edit' || name === 'Write') {
                  const filePath = tc.arguments?.file_path || tc.arguments?.filePath || tc.targetFilePath;
                  return filePath ? `edited ${String(filePath).split('/').pop()}` : 'edited a file';
                } else if (name === 'Read') {
                  const filePath = tc.arguments?.file_path || tc.arguments?.filePath || tc.targetFilePath;
                  return filePath ? `read ${String(filePath).split('/').pop()}` : 'read a file';
                } else if (name === 'Bash') {
                  return 'ran a command';
                } else if (name === 'Grep' || name === 'Glob') {
                  return 'searched files';
                }
                return name?.toLowerCase?.() || 'used a tool';
              }).join(', ');
              contextParts.push(`Recent tools: ${toolSummary}`);
            }

            // Include the tail of the actual conversation so the voice agent
            // knows what has been discussed. Extract the last few user prompts
            // and assistant text responses (skip tool/system events).
            const conversationTail = conversationEvents
              .slice(-6)
              .map(m => {
                const role = m.type === 'user_message' ? 'User' : 'Agent';
                const text = typeof m.text === 'string' ? m.text : '';
                if (!text.trim()) return null;
                // Truncate each message to keep total size manageable
                const truncated = text.length > 500
                  ? text.substring(0, 500) + '...'
                  : text;
                return `${role}: ${truncated}`;
              })
              .filter(Boolean);

            if (conversationTail.length > 0) {
              contextParts.push(`\nRecent conversation:\n${conversationTail.join('\n')}`);
            }
          }

          sessionContext = contextParts.join('\n');
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to load session context:', error);
      }

      // Get files that have been read or edited during this session
      try {
        const { SessionFilesRepository } = await import('@nimbalyst/runtime/storage/repositories/SessionFilesRepository');
        const [editedFiles, readFiles] = await Promise.all([
          SessionFilesRepository.getFilesBySession(sessionId, 'edited'),
          SessionFilesRepository.getFilesBySession(sessionId, 'read'),
        ]);

        // Combine and dedupe, prioritizing edited files
        const allFiles = [...editedFiles];
        for (const file of readFiles) {
          if (!allFiles.some(f => f.filePath === file.filePath)) {
            allFiles.push(file);
          }
        }

        if (allFiles.length > 0) {
          // Show up to 8 files, with edited files first
          const fileList = allFiles.slice(0, 8).map(f => {
            const fileName = f.filePath.split('/').pop();
            const isEdited = editedFiles.some(e => e.filePath === f.filePath);
            return isEdited ? `${fileName} (edited)` : fileName;
          }).join(', ');
          sessionContext += `\nSession files: ${fileList}`;
        }
      } catch (error) {
        // Ignore - session files are optional context
        console.error('[VoiceModeService] Failed to load session files:', error);
      }

      // Load AI-generated project summary for voice mode context
      // This is stored in nimbalyst-local/voice-project-summary.md and generated on demand
      if (workspacePath) {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');

          const summaryPath = path.join(workspacePath, 'nimbalyst-local', 'voice-project-summary.md');
          const summaryContent = await fs.readFile(summaryPath, 'utf-8').catch(() => null);

          if (summaryContent) {
            // Include the full summary - it's already AI-curated to be concise and voice-friendly
            sessionContext += `\n\nProject Summary:\n${summaryContent.trim()}`;
          }
        } catch (error) {
          // Ignore - summary file is optional
        }
      }

      // NOTE: Initial active file context is sent by the renderer via
      // voice-mode:editor-context-changed IPC after voiceActiveSessionIdAtom is set.
      // The voiceModeListeners subscription fires checkAndReportFileChange automatically.

      // Load custom voice agent prompt, turn detection settings, and voice
      const voiceModeSettings = voiceModeSettingsStore.get('voiceMode') as {
        voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
        model?: RealtimeModel;
        reasoningEffort?: RealtimeReasoningEffort;
        voiceAgentPrompt?: { prepend?: string; append?: string };
        codingAgentPrompt?: { prepend?: string; append?: string };
        turnDetection?: {
          mode: 'server_vad' | 'push_to_talk';
          detection?: 'semantic_vad' | 'server_vad';
          vadThreshold?: number;
          silenceDuration?: number;
          interruptible?: boolean;
        };
        noiseReduction?: 'near_field' | 'far_field' | 'off';
      } | undefined;
      const customPrompt = voiceModeSettings?.voiceAgentPrompt || {};
      const turnDetection = {
        ...(voiceModeSettings?.turnDetection || {
          mode: 'server_vad' as const,
          silenceDuration: 500,
          interruptible: true,
        }),
        // Echo round 2 defaults: model-judged semantic_vad (echo-robust; the
        // old amplitude server_vad tripped on residual echo at 0.5) and
        // far_field noise reduction (loud open speakers are the echo case).
        // Persisted settings can override both.
        detection: voiceModeSettings?.turnDetection?.detection ?? ('semantic_vad' as const),
        noiseReduction: voiceModeSettings?.noiseReduction ?? ('far_field' as const),
        // A persisted 0.5 is indistinguishable from the old default and lets
        // echo trip amplitude VAD -- treat it as unset so the raised builder
        // default applies (matches the iOS NIM-1314 migration).
        ...(voiceModeSettings?.turnDetection?.vadThreshold === 0.5 ? { vadThreshold: undefined } : {}),
      };
      const selectedVoice = voiceModeSettings?.voice || 'alloy';
      // Old persisted settings predate these fields -- fall back to the defaults.
      const selectedModel: RealtimeModel = voiceModeSettings?.model ?? 'gpt-realtime-2';
      const reasoningEffort: RealtimeReasoningEffort = voiceModeSettings?.reasoningEffort ?? 'low';
      // Pin the voice agent's spoken language to the desktop's configured default
      // (undefined -> RealtimeAPIClient falls back to English).
      const preferredLanguage = getPreferredAgentLanguage();

      // Core hook 2: let extensions contribute to the voice session context at
      // start (e.g. top-N grounding facts). Appended before the client is built
      // so it ships in the initial session instructions.
      try {
        const extensionContext = await requestExtensionVoiceContext(window, {
          workspacePath: workspacePath ?? undefined,
          voiceSessionId: sessionId,
          codingSessionId: sessionId,
        });
        if (extensionContext && extensionContext.trim().length > 0) {
          sessionContext += `\n\n${extensionContext.trim()}`;
          console.log(`[VoiceModeService] Appended ${extensionContext.length} chars of extension voice context`);
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to collect extension voice context:', error);
      }

      // Create PoC instance with agent session context, custom prompt, turn detection, voice, model, and reasoning effort
      const poc = new RealtimeAPIClient(apiKey, sessionId, workspacePath, window, sessionContext, customPrompt, turnDetection, selectedVoice, selectedModel, reasoningEffort, preferredLanguage);

      // Core hook 1: expose extension-contributed voice tools to the Realtime
      // session. Must be set before connect() so the tool list ships in the
      // session config. Dispatch reuses the existing extension-tool execution
      // path (the same route MCP uses via handleExtensionTool).
      try {
        // Voice tools come from two sources: renderer-declared extension tools
        // (dispatched to the renderer) and backend-module-registered tools
        // (dispatched main->backend, no renderer hop — protects the voice
        // latency budget). Merge both into the Realtime tool list.
        const [extVoiceTools, backendVoiceTools] = await Promise.all([
          getVoiceEnabledExtensionTools(workspacePath ?? undefined),
          getVoiceEnabledBackendToolsForWorkspace(workspacePath ?? undefined),
        ]);
        const voiceTools = [...extVoiceTools, ...backendVoiceTools];
        if (voiceTools.length > 0) {
          const { schemas, nameMap } = buildVoiceToolSet(voiceTools, {
            reservedNames: new Set(BUILTIN_VOICE_TOOL_NAMES),
          });
          poc.setExtensionVoiceTools(schemas, nameMap);
          poc.setOnExtensionVoiceTool(async (namespacedName, args) => {
            const targetWorkspace = activeVoiceSession?.workspacePath ?? workspacePath ?? undefined;
            const targetSessionId = activeVoiceSession?.sessionId ?? sessionId;
            try {
              // Route backend tools to the module; everything else to the
              // renderer extension path. Resolve worktree paths so the registry
              // and module lookups hit the project the module started for.
              let result;
              const resolvedWs = targetWorkspace
                ? await resolveBackendWorkspacePath(targetWorkspace)
                : undefined;
              if (resolvedWs && isBackendTool(namespacedName, resolvedWs)) {
                result = await handleBackendTool(
                  namespacedName,
                  namespacedName,
                  args,
                  resolvedWs
                );
              } else {
                result = await handleExtensionTool(
                  namespacedName, // toolName -- matches the registered (dotted) name
                  namespacedName, // originalName (for error messages)
                  args,
                  targetSessionId,
                  targetWorkspace
                );
              }
              const text = (result.content || [])
                .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                .filter(Boolean)
                .join('\n');
              return { success: !result.isError, message: text };
            } catch (error) {
              console.error('[VoiceModeService] Extension voice tool dispatch failed:', namespacedName, error);
              return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
          });
          console.log(
            `[VoiceModeService] Exposed ${schemas.length} voice tool(s) (${extVoiceTools.length} extension, ${backendVoiceTools.length} backend): ${Array.from(nameMap.values()).join(', ')}`
          );
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to load voice tools:', error);
      }

      // Helper: get the current linked session ID (may change if user switches sessions)
      const currentSessionId = () => activeVoiceSession?.sessionId ?? sessionId;

      // Set up callbacks to forward audio/text to renderer
      // Use currentSessionId() so events always target the current session
      poc.setOnAudio((audioBase64) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:audio-received', { sessionId: currentSessionId(), audioBase64 });
        }
      });

      poc.setOnText((text) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:text-received', { sessionId: currentSessionId(), text });
        }
      });

      poc.setOnUserTranscript((transcript) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:transcript-complete', { sessionId: currentSessionId(), transcript });
        }
      });

      poc.setOnUserTranscriptDelta((delta, itemId) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:transcript-delta', { sessionId: currentSessionId(), delta, itemId });
        }
      });

      poc.setOnTokenUsage((usage) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:token-usage', { sessionId: currentSessionId(), usage });
        }
      });

      poc.setOnToolCall((event) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:tool-call', { sessionId: currentSessionId(), event });
        }
      });

      // Load coding agent prompt settings for inclusion in submit-prompt events
      const codingAgentPromptSettings = voiceModeSettings?.codingAgentPrompt || {};

      poc.setOnSubmitPrompt(async (prompt) => {
        if (window && !window.isDestroyed()) {
          // Include coding agent prompt settings so they can be passed to the provider
          window.webContents.send('voice-mode:submit-prompt', {
            sessionId: currentSessionId(),
            workspacePath,
            prompt,
            codingAgentPrompt: codingAgentPromptSettings,
          });
        }
      });

      poc.setOnInterruption(() => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:interrupt', { sessionId: currentSessionId() });
        }
      });

      poc.setOnSpeechStopped(() => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:speech-stopped', { sessionId: currentSessionId() });
        }
      });

      // Unconditional VAD speech-start signal (unlike voice-mode:interrupt,
      // which the barge-in policy can defer or suppress). The renderer uses
      // it to hold the listen window open for the whole utterance (NIM-1594).
      poc.setOnSpeechStarted(() => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:speech-started', { sessionId: currentSessionId() });
        }
      });

      poc.setOnError((error) => {
        console.error('[VoiceModeService] Error from OpenAI:', error.type, error.message);
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:error', { sessionId: currentSessionId(), error });
        }
      });

      // Transient reconnect state: surface "reconnecting…" to the renderer
      // instead of silently dying. A hard voice-mode:error is only emitted
      // after retries are exhausted (handled by setOnError above).
      poc.setOnReconnecting((attempt) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:reconnecting', { sessionId: currentSessionId(), attempt });
        }
      });

      poc.setOnReconnected(() => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:reconnected', { sessionId: currentSessionId() });
        }
      });

      // Set up callbacks for voice agent tools
      poc.setOnStopSession(() => {
        return stopVoiceSession();
      });

      poc.setOnPauseListening(() => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('voice-mode:pause-listening', { sessionId: currentSessionId() });
        }
      });

      poc.setOnGetSessionSummary(async () => {
        const result = await getSessionSummary();
        return {
          success: result.success,
          summary: result.summary,
          error: result.error,
        };
      });

      // Respond to interactive prompts (AskUserQuestion, ExitPlanMode, etc.)
      poc.setOnRespondToPrompt(async (params) => {
        try {
          const targetSessionId = currentSessionId();
          console.log('[VoiceModeService] respond_to_interactive_prompt:', {
            promptId: params.promptId,
            promptType: params.promptType,
            answer: params.answer,
          });

          // Build the response object based on prompt type
          let response: any;
          if (params.promptType === 'ask_user_question_request') {
            // AskUserQuestion expects { answers: { questionText: answerText } }
            // We don't have the question text, but the resolver just needs the answers object
            response = { answers: { _voice: params.answer } };
          } else if (params.promptType === 'exit_plan_mode_request') {
            response = { approved: params.answer.toLowerCase() === 'approve' };
          } else if (params.promptType === 'git_commit_proposal_request') {
            response = { approved: params.answer.toLowerCase() === 'approve' };
          } else {
            response = { answer: params.answer };
          }

          // Send the response through the renderer (which has access to the atoms and IPC)
          if (window && !window.isDestroyed()) {
            window.webContents.send('voice-mode:respond-to-prompt', {
              sessionId: targetSessionId,
              promptId: params.promptId,
              promptType: params.promptType,
              response,
            });
          }

          return { success: true };
        } catch (error) {
          console.error('[VoiceModeService] Failed to respond to prompt:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });

      // List sessions in this workspace. When a topic query is given and the
      // memory engine is running, this matches session *content* semantically
      // (e.g. "the session working on the collaborative document system")
      // rather than only session titles, then falls back to title/transcript
      // full-text search so nothing regresses when the engine is unavailable.
      poc.setOnListSessions(async (query?: string) => {
        const wp = activeVoiceSession?.workspacePath;
        if (!wp) {
          return { success: false, error: 'No workspace path available' };
        }
        // Shared with the mobile voice-tool proxy (mobileVoiceToolHandler) so
        // the iOS agent gets the identical semantic, memory-backed lookup.
        return searchSessionsForVoice(wp, query);
      });

      // Create a new coding session and switch to it
      poc.setOnCreateSession(async (title?: string) => {
        try {
          const wp = activeVoiceSession?.workspacePath ?? workspacePath;
          if (!wp) {
            return { success: false, error: 'No workspace path available' };
          }

          const newSessionId = randomUUID();
          const provider = 'claude-code';
          const model = getDefaultAIModel() || 'claude-code:opus-1m';
          const newTitle = title?.trim() || 'New Session';

          await AISessionsRepository.create({
            id: newSessionId,
            provider,
            model,
            title: newTitle,
            workspaceId: wp,
          });

          // Refresh the renderer's session registry so the new session appears
          // in the sidebar, then navigate to it. The active-session change will
          // be picked up by voiceModeListeners.syncLinkedSession, which updates
          // the linked session ID for subsequent voice commands automatically.
          if (window && !window.isDestroyed()) {
            window.show();
            window.focus();
            window.webContents.send('sessions:refresh-list', {
              workspacePath: wp,
              sessionId: newSessionId,
            });
            window.webContents.send('tray:navigate-to-session', {
              sessionId: newSessionId,
              workspacePath: wp,
            });
          }

          return { success: true, sessionId: newSessionId, title: newTitle };
        } catch (error) {
          console.error('[VoiceModeService] Failed to create session:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });

      // Propose a commit via the "Commit with AI" path. The voice agent
      // calls this when the user says "propose a commit". We forward to
      // the renderer so it can run the SAME logic as the Smart Commit
      // button in GitOperationsPanel (git:get-commit-context +
      // ai:sendMessage with the COMMIT_REQUEST_PREFIX message). That makes
      // the "Requesting commit proposal" widget appear in the transcript
      // and the coding agent invoke developer_git_commit_proposal, which
      // returns through the existing interactive-prompt forwarding.
      poc.setOnProposeCommit(async () => {
        try {
          if (!window || window.isDestroyed()) {
            return { success: false, error: 'Window not available' };
          }
          window.webContents.send('voice-mode:propose-commit', {
            sessionId: currentSessionId(),
            workspacePath,
          });
          return { success: true };
        } catch (error) {
          console.error('[VoiceModeService] Failed to propose commit:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      // Navigate to a specific session
      poc.setOnNavigateToSession(async (sessionId: string) => {
        try {
          const session = await AISessionsRepository.get(sessionId);
          if (!session) {
            return { success: false, error: `Session not found: ${sessionId}` };
          }

          const wp = activeVoiceSession?.workspacePath;
          if (!wp) {
            return { success: false, error: 'No workspace path available' };
          }

          // Send navigation IPC to renderer (same channel the tray uses)
          if (window && !window.isDestroyed()) {
            window.show();
            window.focus();
            window.webContents.send('tray:navigate-to-session', {
              sessionId,
              workspacePath: wp,
            });
          }

          return { success: true, title: session.title || sessionId };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });

      // Track whether an ask_coding_agent call is in-flight so the
      // completion listener doesn't also fire an [INTERNAL] notification
      // for the same response (which would cause the voice agent to say
      // "I finished that task" instead of summarizing the answer).
      let askCodingAgentInFlight = false;

      poc.setOnAskCodingAgent(async (question: string) => {
        // Send the question to the coding agent via the existing prompt system
        // The [VOICE] prefix signals this is from the voice assistant
        // The system prompt (via isVoiceMode in documentContext) provides full context
        const questionPrompt = `[VOICE] ${question}`;
        const targetSessionId = currentSessionId();

        console.log('[VoiceModeService] ask_coding_agent called with question:', question, 'target:', targetSessionId);
        askCodingAgentInFlight = true;

        try {
          if (window && !window.isDestroyed()) {
            // Create a promise that resolves when the agent responds
            return new Promise((resolve) => {
              let timeoutId: NodeJS.Timeout | null = null;

              // Set up a one-time listener for the response via ipcMain
              // This listens for the same event that submit_agent_prompt uses
              const responseHandler = (_event: any, data: { sessionId: string; summary: string }) => {
                if (data.sessionId === targetSessionId) {
                  // Clean up
                  ipcMain.removeListener('voice-mode:agent-task-complete', responseHandler);
                  if (timeoutId) clearTimeout(timeoutId);
                  askCodingAgentInFlight = false;

                  // Log what we received
                  console.log('[VoiceModeService] ask_coding_agent received response:', {
                    summaryLength: data.summary?.length,
                    summaryPreview: data.summary?.substring(0, 500),
                  });

                  // Truncate the answer for the voice context window.
                  // gpt-realtime struggles with very long function results.
                  const answer = data.summary || 'I was unable to find an answer.';
                  const truncatedAnswer = answer.length > 2000
                    ? answer.substring(0, 2000) + '... (truncated)'
                    : answer;

                  resolve({
                    success: true,
                    answer: truncatedAnswer,
                  });
                }
              };

              // Listen for the response
              ipcMain.on('voice-mode:agent-task-complete', responseHandler);

              // Send the question to the renderer to queue
              window.webContents.send('voice-mode:submit-prompt', {
                sessionId: targetSessionId,
                workspacePath,
                prompt: questionPrompt,
              });

              // Timeout after 60 seconds
              timeoutId = setTimeout(() => {
                ipcMain.removeListener('voice-mode:agent-task-complete', responseHandler);
                askCodingAgentInFlight = false;
                resolve({
                  success: false,
                  error: 'Question timed out waiting for response',
                });
              }, 60000);
            });
          } else {
            askCodingAgentInFlight = false;
            return { success: false, error: 'Window not available' };
          }
        } catch (error) {
          askCodingAgentInFlight = false;
          console.error('[VoiceModeService] Failed to ask coding agent:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      });

      // Track when connection is closed (for timeout/error disconnect reasons)
      const sessionStartTime = Date.now();
      poc.setOnDisconnect((reason) => {
        // Only send analytics if this is still the active session
        // (user_stopped is handled separately in the disconnect handler)
        if (activeVoiceSession?.sessionId === sessionId && reason !== 'user_stopped') {
          sendSessionEndedEvent(reason, sessionStartTime);
          // Clean up session on auto-disconnect
          activeVoiceSession.cleanupCompletionListener();
          activeVoiceSession = null;
        }
      });

      // Listen for agent completion events
      // When the coding agent finishes a task, we'll get a message from the renderer
      // and can notify the voice assistant.
      // IMPORTANT: Skip this when ask_coding_agent is in-flight because
      // that path returns the response via the function call result instead.
      const completionListener = (_event: any, data: { sessionId: string; summary?: string }) => {
        console.log('[VoiceModeService] agent-task-complete received:', {
          sessionId: data.sessionId,
          summaryLength: data.summary?.length ?? 0,
          summaryPreview: data.summary?.substring(0, 200) ?? '(empty)',
          askCodingAgentInFlight,
        });

        if (data.sessionId === currentSessionId()) {
          // Don't send [INTERNAL] notification when ask_coding_agent is handling
          // this response -- the answer goes back via the function call result.
          if (askCodingAgentInFlight) {
            return;
          }

          // Truncate the summary to stay within the realtime context limits.
          const trimmed = (data.summary ?? '').trim();
          const truncatedSummary = trimmed.length > 1500
            ? trimmed.substring(0, 1500) + '... (truncated)'
            : trimmed;

          // Async (deferred) path (gpt-realtime-2): if a submit_agent_prompt call
          // is still open, resolve it with the real summary -- the agent receives
          // the result as the tool's return value and relays it. No injected wake.
          if (poc.hasDeferredCall()) {
            const resolved = poc.resolveDeferredCall({
              success: true,
              summary: truncatedSummary || 'The coding agent finished but did not produce a text summary.',
            });
            if (resolved) {
              console.log('[VoiceModeService] Resolved deferred submit_agent_prompt with summary');
              return;
            }
          }

          // Fallback path (gpt-realtime, or no open deferred call): inject an
          // [INTERNAL: Task complete] wake message for the voice agent to relay.
          const completionMessage = truncatedSummary.length > 0
            ? `[INTERNAL: Task complete. Result: ${truncatedSummary}]`
            : '[INTERNAL: Task complete. The coding agent finished but did not produce a text summary.]';

          console.log('[VoiceModeService] Sending completion to voice agent:', completionMessage.substring(0, 300));
          poc.sendUserMessage(completionMessage);
        }
      };
      ipcMain.on('voice-mode:agent-task-complete', completionListener);

      // Store cleanup function for this listener
      const cleanupCompletionListener = () => {
        ipcMain.removeListener('voice-mode:agent-task-complete', completionListener);
      };

      // Connect
      await poc.connect();

      // Store active session info
      activeVoiceSession = {
        poc,
        window,
        workspacePath,
        sessionId,
        cleanupCompletionListener,
        startTime: Date.now(),
        hasExistingSession,
      };

      // Track session started
      AnalyticsService.getInstance().sendEvent('voice_session_started');

      console.log('[VoiceModeService] Voice mode activated for sessionId:', sessionId);

      return {
        success: true,
        message: 'Successfully connected to OpenAI Realtime API',
        sessionId: poc.isConnected() ? 'connected' : null,
      };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Disconnect from OpenAI
   */
  safeHandle('voice-mode:test-disconnect', async (_event, workspacePath: string | null, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      let tokenUsage: { inputAudio: number; outputAudio: number; text: number; total: number } | undefined;

      // Only disconnect if this is the active session
      if (activeVoiceSession && activeVoiceSession.sessionId === sessionId) {
        // Track session ended before cleanup
        sendSessionEndedEvent('user_stopped', activeVoiceSession.startTime);

        // Get final token usage before disconnect
        tokenUsage = activeVoiceSession.poc.getTokenUsage();

        activeVoiceSession.poc.disconnect();
        // Clean up the completion listener
        activeVoiceSession.cleanupCompletionListener();
        activeVoiceSession = null;
      }

      return {
        success: true,
        message: 'Disconnected',
        tokenUsage,
      };
    } catch (error) {
      return {
        success: false,
        message: `Disconnect failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Check connection status
   */
  safeHandle('voice-mode:test-status', async (_event, workspacePath: string | null, sessionId: string) => {
    const isActiveSession = activeVoiceSession?.sessionId === sessionId;
    const connected = isActiveSession && activeVoiceSession?.poc.isConnected() || false;
    return {
      success: true,
      connected,
      message: connected ? 'Connected' : 'Disconnected',
    };
  });

  /**
   * Send audio chunk to OpenAI
   */
  safeHandle('voice-mode:send-audio', async (_event, workspacePath: string | null, sessionId: string, audioBase64: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
        throw new Error('No active voice session for this session ID');
      }

      if (!activeVoiceSession.poc.isConnected()) {
        throw new Error('Not connected to OpenAI');
      }

      activeVoiceSession.poc.sendAudio(audioBase64);

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Send audio failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Commit audio buffer (tell OpenAI to process it)
   */
  safeHandle('voice-mode:commit-audio', async (_event, workspacePath: string | null, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
        throw new Error('No active voice session for this session ID');
      }

      if (!activeVoiceSession.poc.isConnected()) {
        throw new Error('Not connected to OpenAI');
      }

      activeVoiceSession.poc.commitAudio();

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Commit audio failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Preview a voice using OpenAI's TTS API
   */
  safeHandle('voice-mode:preview-voice', async (event, voiceId: string) => {
    try {
      // Get OpenAI API key
      const apiKeys = settingsStore.get('apiKeys') as Record<string, string> | undefined;
      const apiKey = apiKeys?.openai;

      if (!apiKey) {
        return {
          success: false,
          message: 'OpenAI API key not configured',
        };
      }

      // TTS API supports: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
      // Realtime API adds: ballad, marin, cedar, verse
      // Map unsupported voices to similar TTS voices for preview
      const ttsVoiceMap: Record<string, string> = {
        'ballad': 'nova',    // Warm and melodic -> Nova
        'marin': 'alloy',    // Natural conversational -> Alloy
        'cedar': 'onyx',     // Deep and resonant -> Onyx
        'verse': 'fable',    // Dynamic and engaging -> Fable
      };

      const ttsVoice = ttsVoiceMap[voiceId] || voiceId;
      const isApproximation = ttsVoiceMap[voiceId] !== undefined;

      // Use OpenAI's TTS API to generate a preview
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: isApproximation
            ? `Hello! I'm ${voiceId}. This preview uses a similar voice. The actual voice in conversation will sound slightly different.`
            : `Hello! I'm ${voiceId}. This is how I sound when speaking to you.`,
          voice: ttsVoice,
          response_format: 'mp3',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS API error: ${response.status} - ${errorText}`);
      }

      // Get the audio data
      const audioBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');

      // Get the window that made the request
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        // Send audio to renderer for playback
        window.webContents.send('voice-mode:preview-audio', {
          voiceId,
          audioBase64,
          format: 'mp3',
        });
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: `Voice preview failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  // Voice-friendly project summary generation lives in the renderer now: the
  // Voice Mode settings panel launches an agent session that writes
  // nimbalyst-local/voice-project-summary.md using its Write tool. See
  // packages/electron/src/renderer/components/Settings/VoiceModePanel.tsx and
  // voiceModeSummaryPrompt.ts. Voice mode loads the resulting file in
  // loadSessionContext above.

  /**
   * Find the most recent voice session for a workspace, if it was updated
   * within the timeout window. Used to resume an existing voice session
   * rather than creating a new one every time the button is pressed.
   */
  safeHandle('voice-mode:findRecentSession', async (_event, data: {
    workspacePath: string;
    timeoutMs: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      const cutoff = new Date(Date.now() - data.timeoutMs);
      const result = await database.query(
        `SELECT id, updated_at FROM ai_sessions
         WHERE workspace_id = $1
           AND session_type = 'voice'
           AND updated_at > $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [data.workspacePath, cutoff]
      );
      if (result.rows.length > 0) {
        return { found: true, sessionId: result.rows[0].id };
      }
      return { found: false };
    } catch (error) {
      console.error('[VoiceModeService] Failed to find recent voice session:', error);
      return { found: false };
    }
  });

  /**
   * Create a voice session row in ai_sessions.
   * Called immediately when voice activates so the session is visible right away.
   */
  safeHandle('voice-mode:createSession', async (_event, data: {
    id: string;
    workspacePath: string;
    linkedSessionId: string;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `INSERT INTO ai_sessions (id, workspace_id, provider, title, session_type, metadata, created_at, updated_at)
         VALUES ($1, $2, 'openai-realtime', 'Voice Session', 'voice', $3, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          data.id,
          data.workspacePath,
          JSON.stringify({ linkedSessionId: data.linkedSessionId }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to create voice session:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Resume an existing voice session by touching its updated_at and
   * updating the linked coding session ID in metadata.
   */
  safeHandle('voice-mode:resumeSession', async (_event, data: {
    sessionId: string;
    linkedSessionId: string;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `UPDATE ai_sessions
         SET updated_at = NOW(),
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [
          data.sessionId,
          JSON.stringify({ linkedSessionId: data.linkedSessionId }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to resume voice session:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Append a single transcript message to a voice session.
   * Called incrementally as user speaks and assistant responds.
   */
  safeHandle('voice-mode:appendMessage', async (_event, data: {
    sessionId: string;
    direction: 'input' | 'output';
    content: string;
    entryId: string;
    timestamp: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at)
         VALUES ($1, 'voice', $2, $3, $4, $5)`,
        [
          data.sessionId,
          data.direction,
          data.content,
          JSON.stringify({ voiceEntryId: data.entryId }),
          new Date(data.timestamp).toISOString(),
        ]
      );
      // Touch updated_at on the session
      await database.query(
        `UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1`,
        [data.sessionId]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to append voice message:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Update voice session metadata (token usage, duration) on stop.
   */
  safeHandle('voice-mode:updateSessionMetadata', async (_event, data: {
    sessionId: string;
    tokenUsage: unknown;
    durationMs: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      // Merge token usage and duration into existing metadata
      await database.query(
        `UPDATE ai_sessions
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          data.sessionId,
          JSON.stringify({
            tokenUsage: data.tokenUsage,
            durationMs: data.durationMs,
          }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to update voice session metadata:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Update the linked AI session for the active voice session.
   * Called when the user switches to a different coding session while voice is active.
   * This ensures voice agent commands (submit-prompt, ask_coding_agent) target the correct session.
   */
  ipcMain.on('voice-mode:update-linked-session', (_event, data: {
    newSessionId: string;
    sessionName?: string;
  }) => {
    if (!activeVoiceSession) return;
    const oldSessionId = activeVoiceSession.sessionId;
    if (oldSessionId === data.newSessionId) return;

    activeVoiceSession.sessionId = data.newSessionId;
    const name = data.sessionName || 'Untitled';
    console.log(`[VoiceModeService] Updated linked session -> "${name}"`);

    // Notify the voice agent so it knows commands now target a different session
    if (activeVoiceSession.poc.isConnected()) {
      activeVoiceSession.poc.injectContext(
        `[INTERNAL: User switched to a different coding session called "${name}". Your commands now target this session.]`
      );
    }
  });

  /**
   * Listen state changed -- renderer notifies when voice goes to sleep or wakes up.
   * Used to suspend/resume the inactivity disconnect timer.
   */
  ipcMain.on('voice-mode:listen-state-changed', (_event, data: { sleeping: boolean }) => {
    if (!activeVoiceSession) return;
    activeVoiceSession.poc.setListeningPaused(data.sleeping);
  });

  /**
   * Audible playback state from the renderer (the renderer owns the playback
   * buffer, so only it knows when the assistant is actually audible -- audio
   * keeps playing after response.done because it streams faster than
   * realtime). Drives echo-vs-genuine barge-in classification and server VAD
   * response gating (echo cancellation round 2).
   */
  ipcMain.on('voice-mode:playback-active', (_event, data: { active: boolean }) => {
    if (!activeVoiceSession) return;
    activeVoiceSession.poc.setPlaybackActive(data.active);
  });

  /**
   * Editor context changed -- user switched to a different file.
   * Notify the active voice agent so it knows what document the user is viewing.
   */
  ipcMain.on('voice-mode:editor-context-changed', (_event, data: {
    sessionId: string;
    filePath: string | null;
  }) => {
    if (!activeVoiceSession || activeVoiceSession.sessionId !== data.sessionId) return;
    if (!activeVoiceSession.poc.isConnected()) return;

    if (data.filePath) {
      // Extract just the filename for the voice agent (full paths are noisy for speech)
      const fileName = data.filePath.split('/').pop() || data.filePath;
      activeVoiceSession.poc.injectContext(
        `[INTERNAL: User is now viewing ${fileName}]`
      );
    }
  });

  /**
   * Interactive prompt notification from the renderer.
   * When a pending prompt appears (AskUserQuestion, ExitPlanMode, etc.),
   * the renderer forwards it here so we can inject it into the voice agent's
   * conversation and let the user respond verbally.
   */
  ipcMain.on('voice-mode:interactive-prompt', (_event, data: {
    sessionId: string;
    promptId: string;
    promptType: string;
    description: string;
  }) => {
    console.log('[VoiceModeService] interactive-prompt IPC received:', {
      promptId: data.promptId,
      promptType: data.promptType,
      hasActiveSession: !!activeVoiceSession,
      isConnected: activeVoiceSession?.poc?.isConnected() ?? false,
      descriptionLength: data.description?.length ?? 0,
      description: data.description,
    });

    if (!activeVoiceSession) {
      console.log('[VoiceModeService] interactive-prompt: no active voice session, skipping');
      return;
    }
    if (!activeVoiceSession.poc.isConnected()) {
      console.log('[VoiceModeService] interactive-prompt: voice agent not connected, skipping');
      return;
    }

    console.log('[VoiceModeService] Forwarding interactive prompt to voice agent:', {
      promptId: data.promptId,
      promptType: data.promptType,
      descriptionLength: data.description.length,
    });

    // Send the prompt as a user message so the voice agent speaks it and responds
    activeVoiceSession.poc.sendUserMessage(
      `[INTERACTIVE PROMPT: promptId="${data.promptId}" promptType="${data.promptType}"]\n${data.description}`
    );
  });

  console.log('[VoiceModeService] Test handlers initialized');
}
