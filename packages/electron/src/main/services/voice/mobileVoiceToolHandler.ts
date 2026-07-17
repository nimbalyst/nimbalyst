/**
 * Mobile voice-tool dispatch (desktop side).
 *
 * The iOS voice agent connects directly to OpenAI but cannot run desktop-hosted
 * voice tools (e.g. the Nimbalyst Memory extension's project-knowledge tools).
 * It proxies those calls over the CollabV3 sync channel as a generic
 * `voiceToolRequest`; this module runs the requested tool on the desktop and
 * returns the result, mirroring the dispatch path VoiceModeService uses for a
 * local voice session.
 *
 * Security: only tools flagged `voiceAgent: true` for the target workspace are
 * runnable. The realtime-safe name from the request must resolve to a
 * registered voice tool, so a mobile client cannot invoke arbitrary tools.
 */

import { buildVoiceToolSet } from './voiceToolBridge';
import { BUILTIN_VOICE_TOOL_NAMES } from './RealtimeAPIClient';
import {
  getVoiceEnabledExtensionTools,
  getVoiceEnabledBackendToolsForWorkspace,
  resolveBackendWorkspacePath,
} from '../../mcp/mcpWorkspaceResolver';
import { handleExtensionTool } from '../../mcp/tools/extensionToolHandler';
import { handleBackendTool, isBackendTool } from '../../mcp/tools/backendToolHandler';
import { searchSessionsForVoice } from './sessionSearch';
import { getSessionSummaryForVoice } from './sessionSummary';
import { answerSessionPromptForVoice } from './answerPrompt';

export interface MobileVoiceToolResult {
  success: boolean;
  /** Human/agent-facing result text (success message or tool output). */
  result?: string;
  error?: string;
}

/**
 * Run a voice-enabled tool requested by a mobile voice agent.
 * @param toolName Realtime-safe tool name (e.g. "search_project_knowledge").
 * @param argsJson JSON-stringified tool arguments.
 * @param workspacePath The desktop workspace the call targets.
 */
export async function handleMobileVoiceToolCall(
  toolName: string,
  argsJson: string,
  workspacePath: string | undefined,
): Promise<MobileVoiceToolResult> {
  if (!workspacePath) {
    return { success: false, error: 'No workspace available for this project on the desktop.' };
  }

  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    args = {};
  }

  // Built-in: session search. Routed through the SAME shared semantic search the
  // desktop voice agent uses (memory-backed hybrid retrieval + FTS), so the
  // mobile agent gets identical results instead of a plain local recency list.
  // Read-only and scoped to this workspace's own sessions, so it's safe to allow
  // even though built-in names are otherwise reserved below.
  if (toolName === 'list_sessions') {
    const query = typeof args.query === 'string' ? args.query : undefined;
    const result = await searchSessionsForVoice(workspacePath, query);
    if (!result.success) {
      return { success: false, error: result.error || 'Session search failed' };
    }
    return { success: true, result: JSON.stringify({ sessions: result.sessions ?? [] }) };
  }

  // Built-in: session summary by id. Lets the mobile agent summarize ANY session
  // the desktop knows about -- including ones surfaced by the desktop-backed
  // list_sessions that aren't in the phone's local DB. Read-only.
  if (toolName === 'get_session_summary') {
    const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
    if (!sessionId) {
      return { success: false, error: 'session_id is required' };
    }
    const result = await getSessionSummaryForVoice(workspacePath, sessionId);
    if (!result.success) {
      return { success: false, error: result.error || 'Could not summarize session' };
    }
    return { success: true, result: result.summary ?? '' };
  }

  // Built-in: answer a session's pending interactive prompt (question /
  // permission / commit). Routes through the same resolution path mobile uses
  // for an in-app answer, so the blocked session resumes. Read+resolve only.
  if (toolName === 'answer_prompt') {
    const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
    const answer = typeof args.answer === 'string' ? args.answer : '';
    if (!sessionId) {
      return { success: false, error: 'session_id is required' };
    }
    if (!answer.trim()) {
      return { success: false, error: 'answer is required' };
    }
    const result = await answerSessionPromptForVoice(workspacePath, sessionId, answer);
    if (!result.success) {
      return { success: false, error: result.error || 'Could not answer the prompt' };
    }
    return { success: true, result: result.message ?? 'Answer submitted.' };
  }

  // Resolve the realtime-safe name to a registered voiceAgent tool. Building the
  // same voice tool set the local session uses (with built-ins reserved) gives
  // us the realtime-safe -> namespaced map and gates to voiceAgent tools only.
  let namespacedName: string | undefined;
  try {
    const [extVoiceTools, backendVoiceTools] = await Promise.all([
      getVoiceEnabledExtensionTools(workspacePath),
      getVoiceEnabledBackendToolsForWorkspace(workspacePath),
    ]);
    const { nameMap } = buildVoiceToolSet([...extVoiceTools, ...backendVoiceTools], {
      reservedNames: new Set(BUILTIN_VOICE_TOOL_NAMES),
    });
    // Exact realtime-safe match first.
    namespacedName = nameMap.get(toolName);
    if (!namespacedName) {
      // Mobile advertises the bare tool name (e.g. "search_project_knowledge");
      // the desktop name is prefixed (e.g. "nimbalyst-memory.search_project_knowledge").
      // Match against the un-prefixed segment of each registered namespaced name.
      for (const namespaced of nameMap.values()) {
        const bare = namespaced.includes('.')
          ? namespaced.slice(namespaced.lastIndexOf('.') + 1)
          : namespaced;
        if (bare === toolName) {
          namespacedName = namespaced;
          break;
        }
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!namespacedName) {
    return { success: false, error: `Tool "${toolName}" is not an available voice tool for this project.` };
  }

  // Dispatch backend-module tools in-process (no renderer hop); route everything
  // else through the renderer extension path. Resolve worktree paths so registry
  // and module lookups hit the project the module started for.
  try {
    const resolvedWs = await resolveBackendWorkspacePath(workspacePath);
    let result;
    if (resolvedWs && isBackendTool(namespacedName, resolvedWs)) {
      result = await handleBackendTool(namespacedName, namespacedName, args, resolvedWs);
    } else {
      result = await handleExtensionTool(namespacedName, namespacedName, args, undefined, workspacePath);
    }
    const text = (result.content || [])
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    return { success: !result.isError, result: text };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
