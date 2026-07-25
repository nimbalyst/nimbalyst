/**
 * Nimbalyst Memory — extension shell (renderer/main half).
 *
 * The grounding ENGINE runs in the backend module (`src/backend.ts`, utility
 * process) and registers its tools onto the unified MCP surface — so the coding
 * agent and voice agent reach `search_project_knowledge` / `recall` / `remember`
 * in-process. This shell adds the renderer-side pieces:
 *
 *  - a voice context provider that injects a short grounding note at voice
 *    session start (so the agent knows it can call the memory tools), and
 *  - a settings panel describing the index + key source.
 *
 * v1 limitation: the renderer cannot call the backend engine directly (there is
 * no generic renderer->backend RPC), so the context provider injects a static
 * note rather than live top-N facts, and the settings panel is informational
 * (live index status / rebuild / facts viewer arrive with a read bridge in a
 * later phase). On-demand grounding still works fully via the voice/agent tools.
 *
 * See ../../nimbalyst-local/plans/voice-agent-grounding-system.md
 */
import type {
  ExtensionAITool,
  ExtensionContext,
  VoiceContextProvider,
  ExtensionAIService,
} from '@nimbalyst/extension-sdk';
import { NimbalystMemorySettings } from './components/SettingsPanel';
import {
  buildGroundingNote,
  BRAINSTORM_CHOREOGRAPHY,
  type GroundingStatus,
  type GroundingFact,
} from './groundingNote';

/**
 * Build the voice context provider. It injects REAL grounding at session start:
 * it reads the live index status and top durable facts over the renderer->backend
 * read bridge (`services.ai.callBackendTool`) and composes them with the
 * brainstorm choreography. If the bridge is unavailable or the backend isn't
 * up yet, it falls back to the choreography note alone so a voice session never
 * starts ungrounded.
 */
function makeGroundingProvider(ai: ExtensionAIService): VoiceContextProvider {
  return {
    id: 'project-knowledge',
    priority: 50,
    provideContext: async (input) => {
      if (!ai.callBackendTool) return BRAINSTORM_CHOREOGRAPHY;
      const ws = input?.workspacePath;
      let status: GroundingStatus | null = null;
      let facts: GroundingFact[] = [];
      try {
        status = (await ai.callBackendTool('memory.status', {}, ws)) as GroundingStatus;
      } catch {
        return BRAINSTORM_CHOREOGRAPHY;
      }
      try {
        const recalled = (await ai.callBackendTool('memory.recall', { limit: 8 }, ws)) as {
          facts?: GroundingFact[];
        };
        facts = Array.isArray(recalled?.facts) ? recalled.facts : [];
      } catch {
        facts = [];
      }
      return buildGroundingNote({ status, facts });
    },
  };
}

/**
 * `get_task_status` — a Nimbalyst-aware voice tool. The host-agnostic engine
 * can't know about Nimbalyst sessions, so this lives in the extension shell and
 * reaches the running-task state through the host AI service. Lets the voice
 * agent answer "is it done yet?" without blocking on the coding agent.
 */
const aiTools: ExtensionAITool[] = [
  {
    name: 'get_task_status',
    description:
      'Check whether the coding task you kicked off (via submit_agent_prompt for ' +
      '/design or /implement) is still running, waiting for your input, finished, ' +
      'or errored. Use this when the user asks "is it done yet?" or "is it still ' +
      'working?" so you can answer immediately instead of waiting.',
    voiceAgent: true,
    scope: 'global',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      const ai = context.extensionContext?.services?.ai;
      if (!ai?.getTaskStatus) {
        return { success: false, message: 'Task status is unavailable.' };
      }
      const status = await ai.getTaskStatus(context.workspacePath);
      if (!status) {
        return { success: true, message: 'There is no active coding task to check.' };
      }
      const label = status.title ? `"${status.title}"` : 'the current task';
      let message: string;
      if (status.waitingForInput) {
        message = `${label} is paused, waiting for your input.`;
      } else if (status.running) {
        message = `${label} is still running.`;
      } else if (status.status === 'error') {
        message = `${label} stopped with an error.`;
      } else {
        message = `${label} has finished.`;
      }
      return { success: true, message, data: status };
    },
  },
];

export function activate(context: ExtensionContext): void {
  if (context.services.ai) {
    context.subscriptions.push(
      context.services.ai.registerVoiceContextProvider(
        makeGroundingProvider(context.services.ai)
      )
    );
  }
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions are released by the host.
}

/** Voice-agent AI tools contributed by this extension (see {@link aiTools}). */
export { aiTools };

/** Project settings route component, referenced by manifest contributions.settingsRoutes. */
export const settingsPanel = {
  NimbalystMemorySettings,
};
