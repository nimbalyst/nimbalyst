/**
 * Voice tool registry: the schemas the voice agent is offered, and the code
 * that runs when it calls one.
 *
 * Transport-independent by construction. The registry never touches a socket:
 * dispatch() returns the tool's result and the caller decides how to deliver
 * it. That lets the Realtime client send a `function_call_output` while a
 * Responses controller feeds the same schemas and handlers through delegation,
 * with no second copy of the tool behavior.
 *
 * The small amount of transport the tools genuinely need -- the session id, the
 * ability to show the model an image, whether long calls can stay open -- comes
 * in as VoiceToolDispatchContext.
 */

import { AnalyticsService } from '../../analytics/AnalyticsService';
import type { RealtimeFunctionTool } from '../voiceToolBridge';

/**
 * Names of the built-in voice tools. Extension-contributed voice tools whose
 * sanitized name collides with one of these are skipped so a built-in is never
 * shadowed.
 */
export const BUILTIN_VOICE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'submit_agent_prompt',
  'stop_voice_session',
  'get_session_summary',
  'ask_coding_agent',
  'pause_listening',
  'respond_to_interactive_prompt',
  'list_sessions',
  'navigate_to_session',
  'create_session',
  'propose_commit',
  'get_ui_context',
  'capture_ui_screenshot',
]);

/** Human-friendly labels for the built-in voice tools (for transcript display). */
const BUILTIN_VOICE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  submit_agent_prompt: 'Send task to coding agent',
  ask_coding_agent: 'Ask coding agent',
  get_session_summary: 'Get session summary',
  list_sessions: 'List sessions',
  navigate_to_session: 'Switch session',
  create_session: 'Create session',
  propose_commit: 'Propose commit',
  get_ui_context: 'Get UI context',
  capture_ui_screenshot: 'Capture UI screenshot',
  respond_to_interactive_prompt: 'Answer prompt',
  pause_listening: 'Pause listening',
  stop_voice_session: 'Stop voice session',
};

/** A function-tool schema as both engines advertise it. */
export interface VoiceToolSchema {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Result shape returned by the generic extension-voice-tool dispatch callback.
 */
export interface ExtensionVoiceToolResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

export interface VoiceUiContextToolResult {
  success: boolean;
  context?: {
    activeView: string;
    selectedFile?: {
      name: string;
      relativePath?: string;
    };
    activeSession?: {
      id: string;
      title: string;
      status: string;
    };
  };
  error?: string;
}

export interface VoiceUiScreenshotToolResult {
  success: boolean;
  imageDataUrl?: string;
  source?: 'active_nimbalyst_window';
  format?: 'jpeg';
  width?: number;
  height?: number;
  bytes?: number;
  capturedAt?: string;
  context?: VoiceUiContextToolResult['context'];
  error?: string;
}

/**
 * A function/tool call the voice agent made. Emitted so the renderer can write
 * it to the voice session transcript (otherwise tool calls are invisible).
 * Sent twice per call: once when started, once when the result is returned.
 */
export type VoiceToolCallEvent =
  | {
      phase: 'started';
      callId: string;
      name: string;
      displayName: string;
      args: Record<string, unknown>;
    }
  | {
      phase: 'completed';
      callId: string;
      name: string;
      displayName: string;
      success: boolean;
      summary?: string;
    };

/**
 * The application behind the tools. Every entry is optional: a handler that is
 * not registered produces a "<thing> callback not registered" tool error rather
 * than a crash, which is what the voice agent can actually recover from.
 */
/**
 * What a coding-prompt submission actually did.
 *
 * `success` means the application queued the prompt -- not that the IPC message
 * left the building. Everything downstream (a durable task id, an open tool
 * call, an "accepted" tool result) is conditional on this, because accepted is
 * a claim about the application's state and a fire-and-forget send is not
 * evidence of it.
 */
export type VoiceSubmitOutcome =
  | { success: true; sessionId: string; submissionId?: string }
  | { success: false; error: string };

/** The submission a tool call produced, for the caller to correlate against. */
export interface VoiceToolSubmission {
  /** The agent session the prompt was queued on. */
  sessionId: string;
  /**
   * The application's id for this specific submission, minted when it was
   * queued. It is what later identifies the agent run this prompt became:
   * without it, a run had to be matched to a task by recency, which is not an
   * identity and bound the wrong one whenever two submissions were queued
   * before the first ran.
   */
  submissionId?: string;
}

export interface VoiceToolHandlers {
  onSubmitPrompt?: (prompt: string) => Promise<VoiceSubmitOutcome>;
  onStopSession?: () => boolean;
  onGetSessionSummary?: () => Promise<{ success: boolean; summary?: string; error?: string }>;
  onAskCodingAgent?: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>;
  onPauseListening?: () => void;
  onRespondToPrompt?: (params: {
    sessionId: string;
    promptId: string;
    promptType: string;
    answer: string;
  }) => Promise<{ success: boolean; error?: string }>;
  onListSessions?: (
    query?: string,
  ) => Promise<{ success: boolean; sessions?: Array<{ id: string; title: string; status: string }>; error?: string }>;
  onNavigateToSession?: (sessionId: string) => Promise<{ success: boolean; title?: string; error?: string }>;
  onCreateSession?: (title?: string) => Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }>;
  onProposeCommit?: () => Promise<{ success: boolean; error?: string }>;
  onGetUiContext?: () => Promise<VoiceUiContextToolResult>;
  onCaptureUiScreenshot?: (reason: string) => Promise<VoiceUiScreenshotToolResult>;
  onExtensionVoiceTool?: (
    namespacedName: string,
    args: Record<string, unknown>,
  ) => Promise<ExtensionVoiceToolResult>;
}

/** What the caller must supply so the tools can reach their transport. */
export interface VoiceToolDispatchContext {
  /**
   * The voice session id, quoted back on interactive-prompt responses so the
   * answer lands on the session that asked.
   */
  sessionId: string;
  /**
   * Whether a long-running call may stay open until its real result exists.
   * When false, submit_agent_prompt returns a synthetic "queued" acknowledgment
   * and the completion arrives later as a wake message instead.
   */
  supportsDeferredCalls: boolean;
  /**
   * Show the model an image before the tool result is delivered. Engines that
   * cannot accept images (GPT-Live) omit it; capture_ui_screenshot then fails
   * with a clear error rather than silently returning metadata for pixels the
   * model never saw.
   */
  injectImage?: (imageDataUrl: string, description: string) => boolean;
  /** Record that listening is now asleep (pause_listening). */
  setListeningPaused?: (paused: boolean) => void;
}

/**
 * Either a result to deliver now, or a call deliberately left open. `deferred`
 * is not "no result yet, poll me" -- it means the caller owns the call id until
 * the real outcome arrives.
 */
export type VoiceToolOutcome =
  | { deferred: false; result: unknown; submission?: VoiceToolSubmission }
  | { deferred: true; submission?: VoiceToolSubmission };

const errorResult = (error: unknown): { deferred: false; result: unknown } => ({
  deferred: false,
  result: { success: false, error: error instanceof Error ? error.message : String(error) },
});

const failure = (error: string): { deferred: false; result: unknown } => ({
  deferred: false,
  result: { success: false, error },
});

const value = (result: unknown): { deferred: false; result: unknown } => ({ deferred: false, result });

export class VoiceToolRegistry {
  /**
   * Mutable on purpose: the engine's existing setOnX() methods assign straight
   * into this bag, so registering a handler stays a one-liner on both engines.
   */
  readonly handlers: VoiceToolHandlers = {};

  // Extension-contributed voice tools (Core hook 1). Schemas are appended to
  // the advertised tool list; nameMap maps the transport-safe name back to the
  // original namespaced (dotted) name for dispatch through the extension path.
  private extensionSchemas: RealtimeFunctionTool[] = [];
  private extensionNameMap: Map<string, string> = new Map();

  /**
   * @param schemas Function-tool schemas to append to the session.
   * @param nameMap Transport-safe name -> namespaced (dotted) name for dispatch.
   */
  setExtensionTools(schemas: RealtimeFunctionTool[], nameMap: Map<string, string>): void {
    this.extensionSchemas = schemas;
    this.extensionNameMap = nameMap;
  }

  /** Built-in tools followed by any extension-contributed voice tools. */
  buildToolSchemas(): VoiceToolSchema[] {
    return [...buildBuiltinToolSchemas(), ...this.extensionSchemas];
  }

  /** A display label for a tool call: built-in label, else its namespaced name. */
  displayNameFor(name: string): string {
    return BUILTIN_VOICE_TOOL_DISPLAY_NAMES[name] ?? this.extensionNameMap.get(name) ?? name;
  }

  /**
   * Run one tool call. `argsJson` stays raw so each tool keeps its own parse
   * failure behavior -- a malformed argument blob for a required-parameter tool
   * must surface as that tool's error, not as an empty-args call.
   */
  async dispatch(
    callId: string,
    name: string,
    argsJson: string,
    ctx: VoiceToolDispatchContext,
  ): Promise<VoiceToolOutcome> {
    const h = this.handlers;

    switch (name) {
      case 'submit_agent_prompt': {
        try {
          const args = JSON.parse(argsJson);
          const prompt = args.prompt;

          // Track prompt submission (no content for privacy)
          AnalyticsService.getInstance().sendEvent('voice_prompt_submitted');

          if (!h.onSubmitPrompt) {
            throw new Error('No submit prompt callback registered');
          }
          const submitted = await h.onSubmitPrompt(prompt);
          if (!submitted.success) {
            // Nothing was queued, so nothing may be reported as accepted and no
            // call may be held open waiting for work that does not exist.
            console.warn(`[VoiceToolRegistry] submit_agent_prompt not queued: ${submitted.error}`);
            return failure(submitted.error);
          }
          const submission: VoiceToolSubmission = {
            sessionId: submitted.sessionId,
            submissionId: submitted.submissionId,
          };

          if (ctx.supportsDeferredCalls) {
            // Keep the call open. The real summary is delivered when the coding
            // agent finishes, instead of returning a synthetic "queued" now and
            // later injecting a wake message. The submission travels with it so
            // only THAT session's completion can resolve this call.
            console.log(
              `[VoiceToolRegistry] submit_agent_prompt deferred (callId=${callId} session=${submitted.sessionId})`,
            );
            return { deferred: true, submission };
          }
          return {
            deferred: false,
            submission,
            result: {
              success: true,
              message:
                'Task queued; it auto-sends after a short countdown the user controls. You will be notified when it completes.',
            },
          };
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to submit prompt to agent:', error);
          return errorResult(error);
        }
      }

      case 'stop_voice_session': {
        try {
          if (!h.onStopSession) return failure('Stop session callback not registered');
          const stopped = h.onStopSession();
          return value({
            success: stopped,
            message: stopped ? 'Voice session ended.' : 'No active session to stop.',
          });
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to stop session:', error);
          return errorResult(error);
        }
      }

      case 'get_session_summary': {
        try {
          if (!h.onGetSessionSummary) return failure('Session summary callback not registered');
          return value(await h.onGetSessionSummary());
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to get session summary:', error);
          return errorResult(error);
        }
      }

      case 'ask_coding_agent': {
        try {
          const args = JSON.parse(argsJson);
          const question = args.question;
          if (!question) return failure('question parameter is required');
          if (!h.onAskCodingAgent) return failure('Ask coding agent callback not registered');
          return value(await h.onAskCodingAgent(question));
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to ask coding agent:', error);
          return errorResult(error);
        }
      }

      case 'pause_listening': {
        try {
          ctx.setListeningPaused?.(true);
          h.onPauseListening?.();
          return value({
            success: true,
            message:
              'Listening paused. The mic will reactivate automatically when a task completes or an event needs attention.',
          });
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to pause listening:', error);
          return errorResult(error);
        }
      }

      case 'respond_to_interactive_prompt': {
        try {
          const args = JSON.parse(argsJson);
          const { promptId, promptType, answer } = args;
          if (!promptId || !promptType || !answer) {
            return failure('promptId, promptType, and answer are all required');
          }
          if (!h.onRespondToPrompt) return failure('Respond to prompt callback not registered');
          return value(
            await h.onRespondToPrompt({ sessionId: ctx.sessionId, promptId, promptType, answer }),
          );
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to respond to prompt:', error);
          return errorResult(error);
        }
      }

      case 'list_sessions': {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          if (!h.onListSessions) return failure('List sessions callback not registered');
          return value(await h.onListSessions(args.query));
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to list sessions:', error);
          return errorResult(error);
        }
      }

      case 'navigate_to_session': {
        try {
          const args = JSON.parse(argsJson);
          const { sessionId } = args;
          if (!sessionId) return failure('sessionId parameter is required');
          if (!h.onNavigateToSession) return failure('Navigate to session callback not registered');
          return value(await h.onNavigateToSession(sessionId));
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to navigate to session:', error);
          return errorResult(error);
        }
      }

      case 'create_session': {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const title =
            typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : undefined;
          if (!h.onCreateSession) return failure('Create session callback not registered');
          return value(await h.onCreateSession(title));
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to create session:', error);
          return errorResult(error);
        }
      }

      case 'propose_commit': {
        try {
          if (!h.onProposeCommit) return failure('Propose commit callback not registered');
          const result = await h.onProposeCommit();
          return value({
            success: result.success,
            message: result.success
              ? 'Commit proposal requested. Wait for the [INTERACTIVE PROMPT] message.'
              : undefined,
            error: result.error,
          });
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to propose commit:', error);
          return errorResult(error);
        }
      }

      case 'get_ui_context': {
        try {
          if (!h.onGetUiContext) return failure('UI context callback not registered');
          return value(await h.onGetUiContext());
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to get UI context:', error);
          return errorResult(error);
        }
      }

      case 'capture_ui_screenshot': {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const reason = typeof args.reason === 'string'
            ? args.reason.replace(/\s+/g, ' ').trim().slice(0, 160)
            : '';
          if (args.userConfirmed !== true) {
            return failure('Explicit user confirmation is required before capturing the UI.');
          }
          if (!reason) return failure('A short capture reason is required.');
          if (!h.onCaptureUiScreenshot) return failure('UI screenshot callback not registered');

          const result = await h.onCaptureUiScreenshot(reason);
          const { imageDataUrl, ...metadata } = result;
          if (!result.success || !imageDataUrl) return value(metadata);
          if (!ctx.injectImage?.(imageDataUrl, reason)) {
            return failure('The screenshot was captured but could not be sent to the voice model.');
          }
          return value(metadata);
        } catch (error) {
          console.error('[VoiceToolRegistry] Failed to capture UI screenshot:', error);
          return errorResult(error);
        }
      }

      default: {
        // Not a built-in tool -- route to an extension-contributed voice tool
        // (Core hook 1) if one is registered under this transport-safe name.
        const namespacedName = this.extensionNameMap.get(name);
        if (namespacedName && h.onExtensionVoiceTool) {
          try {
            const args = argsJson ? JSON.parse(argsJson) : {};
            return value(await h.onExtensionVoiceTool(namespacedName, args));
          } catch (error) {
            console.error('[VoiceToolRegistry] Extension voice tool failed:', name, error);
            return errorResult(error);
          }
        }

        console.error('[VoiceToolRegistry] Unknown function call:', name);
        return value({ error: 'Unknown function' });
      }
    }
  }
}

/**
 * Built-in voice tool schemas advertised on every session. Extension-
 * contributed voice tools are appended in buildToolSchemas().
 */
export function buildBuiltinToolSchemas(): VoiceToolSchema[] {
  return [
    {
      type: 'function',
      name: 'submit_agent_prompt',
      description: 'Queue a coding task for yourself to process. Use this when the user asks you to write code, fix bugs, refactor, or perform any coding task. The task is queued and sends automatically after a brief on-screen countdown the user controls -- do NOT ask the user to approve or confirm before calling this. You will be notified when it completes.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The coding task to queue for yourself. Be specific and include all relevant context from the conversation. IMPORTANT: End your prompt with "When done, provide a clear 1-sentence summary of what was changed or fixed." This ensures you get a useful summary to relay to the user.',
          },
        },
        required: ['prompt'],
      },
    },
    {
      type: 'function',
      name: 'stop_voice_session',
      description: 'End the current voice mode session. Use this when the user says goodbye, wants to stop talking, or the conversation is complete. This will disconnect from voice mode.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'get_session_summary',
      description: 'Get a summary of the current AI session. Returns the session name, message counts, duration, recent topics, and any pending user question as the final section. Use this when the user asks what has been discussed or wants a recap.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'ask_coding_agent',
      description: 'Send a message to the coding agent. IMPORTANT: When the user says "ask the coding agent X" or "tell the coding agent Y", pass their message VERBATIM - do not rephrase or interpret it. The coding agent can search files, read code, look up documentation, run web searches, or answer questions. You are a voice relay - pass through what the user says exactly.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The message to send to the coding agent. PASS VERBATIM what the user said - do not rephrase, interpret, or add context. If user says "ask coding agent for a random number", send "give me a random number". If user says "tell coding agent HMR is not the problem", send "HMR is not the problem".',
          },
        },
        required: ['question'],
      },
    },
    {
      type: 'function',
      name: 'pause_listening',
      description: 'Pause listening for voice input. The voice session stays active but the microphone goes to sleep. Use when the user says to stop listening, go to sleep, be quiet, or pause. The mic will reactivate automatically when a coding task completes or another event requires your attention. Do NOT tell the user the mic will reactivate when they speak -- they cannot trigger it by speaking while paused.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'respond_to_interactive_prompt',
      description: 'Respond to an interactive prompt from the coding agent (e.g. AskUserQuestion, ExitPlanMode, GitCommitProposal). When you receive an "[INTERACTIVE PROMPT: ...]" message, read the question and options to the user, listen for their answer, then call this tool with their response. For AskUserQuestion: set answer to the option label the user chose (or their free-text answer). For ExitPlanMode: set answer to "approve" or "reject". For GitCommitProposal: set answer to "approve" or "reject".',
      parameters: {
        type: 'object',
        properties: {
          promptId: {
            type: 'string',
            description: 'The promptId from the interactive prompt message.',
          },
          promptType: {
            type: 'string',
            description: 'The type of prompt: "ask_user_question_request", "exit_plan_mode_request", or "git_commit_proposal_request".',
          },
          answer: {
            type: 'string',
            description: 'The user\'s answer. For AskUserQuestion: the selected option label or free-text. For ExitPlanMode/GitCommitProposal: "approve" or "reject".',
          },
        },
        required: ['promptId', 'promptType', 'answer'],
      },
    },
    {
      type: 'function',
      name: 'list_sessions',
      description: 'List or find AI sessions in this workspace. Returns session IDs, titles, running status, and a "lastActive" time (e.g. "2 hours ago"). With no query it returns the most recent sessions. With a query it finds sessions by TOPIC, semantically matching what each session was actually working on (its prompts and the work done) -- not just the title -- so "the session working on the collaborative document system" resolves even when those words are not in the title. Use this before navigating to a session. When the user asks for "the most recent session working on X", pass X as the query and pick the result with the most recent "lastActive".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional topic to find sessions by. Describe what the session was about (e.g. "collaborative document system", "voice mode bugs"); content is matched semantically, not just titles.',
          },
        },
        required: [],
      },
    },
    {
      type: 'function',
      name: 'navigate_to_session',
      description: 'Switch the Nimbalyst UI to a specific AI session, bringing it into focus. Use this when the user asks to switch to, open, or go to a particular session. Call list_sessions first to find the session ID.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The session ID to navigate to.',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      type: 'function',
      name: 'create_session',
      description: 'Create a new coding session in the current workspace and switch to it. Use this when the user asks to start a new session, open a fresh chat, begin a new task, or anything that implies starting from scratch. After this returns, future submit_agent_prompt and ask_coding_agent calls will target the new session.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Optional short title for the new session (e.g. "Refactor auth flow"). If the user gave a topic, derive a brief title from it. Omit if the user did not specify what the session is for.',
          },
        },
        required: [],
      },
    },
    {
      type: 'function',
      name: 'propose_commit',
      description: 'Trigger the "Commit with AI" feature. Use this when the user says "propose a commit", "commit with AI", "smart commit", or asks you to summarize and commit their changes. The coding agent will draft a commit message and file list. When manual approval is required, the proposal arrives shortly as an [INTERACTIVE PROMPT: ... promptType="git_commit_proposal_request"] message -- read only its commit title using the required system-instruction phrasing, then wait for the user to say "approve" or "reject" and call respond_to_interactive_prompt with their answer. With auto-approve enabled, no approval is needed: wait for the coding agent result and report whether the commit succeeded or failed; never ask to approve or reject an auto-approved commit.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'get_ui_context',
      description: 'Read a concise snapshot of the current Nimbalyst UI: active view, selected workspace file, and active coding session. This is read-only and omits absolute paths and hidden renderer state. Use it when the user asks what is currently open, selected, or active.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      type: 'function',
      name: 'capture_ui_screenshot',
      description: 'Capture and inspect the visible Nimbalyst application window. The screenshot pixels are sent to this OpenAI Realtime session and are not written to disk. Call ONLY after the user explicitly asks for a UI screenshot/inspection or explicitly confirms after you explain the capture.',
      parameters: {
        type: 'object',
        properties: {
          userConfirmed: {
            type: 'boolean',
            description: 'Must be true only when the user explicitly requested or confirmed this screenshot capture.',
          },
          reason: {
            type: 'string',
            description: 'A short reason for the capture, for example "inspect the active settings panel". Do not include secrets or file contents.',
            maxLength: 160,
          },
        },
        required: ['userConfirmed', 'reason'],
      },
    },
  ];
}
