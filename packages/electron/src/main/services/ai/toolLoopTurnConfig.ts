/**
 * Tools and system prompt for providers whose tool loop the host feeds.
 * Moved out of MessageStreamingHandler unchanged.
 */

import {
  ModelRegistry,
  buildMetaAgentSystemPrompt,
  buildDevAgentSystemPrompt,
} from '@nimbalyst/runtime/ai/server';
import type { AIModel, AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { getAgentProviderRegistry } from '../../extensions/AgentProviderRegistry';
import { getMetaAgentOpenAITools } from '../../mcp/metaAgentServer';
import { getDevAgentOpenAITools, resolveDevToolScope } from '../../mcp/devAgentTools';
import { MetaAgentService } from '../MetaAgentService';
import { usesHostSuppliedToolLoop } from './providerResolution';

/**
 * Resolve the human-readable model name (e.g. "Gemini 3.5 Flash (High)") for a
 * tool-loop agent provider, so the system prompt can tell the model its real
 * name instead of the raw internal id.
 *
 * Two sources because there are two kinds of tool-loop provider: an extension
 * declares its models in its manifest, while a built-in one publishes them
 * through `ModelRegistry`. Returns undefined for anything else — an
 * MCP-discovering provider builds its own prompt.
 */
export function resolveToolLoopModelDisplayName(
  provider: string,
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  try {
    const entry = getAgentProviderRegistry().findByContributionId(provider);
    if (entry) {
      const match = entry.contribution.models?.find(
        (m) => m.id === model || m.id.endsWith(`:${model}`),
      );
      return match?.name;
    }
    // Built-in: read the cached catalog only. A network/subprocess fetch here
    // would sit on the hot path of every turn just to prettify a prompt line;
    // an unpopulated cache degrades to the raw id, which is cosmetic.
    const cached = ModelRegistry.getCachedModels(provider as AIProviderType);
    return cached?.find((m: AIModel) => m.id === model || m.id.endsWith(`:${model}`))?.name;
  } catch {
    return undefined;
  }
}

interface ToolLoopSession {
  id: string;
  provider: string;
  model?: string | null;
  agentRole?: string | null;
  metadata?: unknown;
}

export function resolveToolLoopTurnConfig(session: ToolLoopSession, effectiveWorkspacePath: string | undefined) {
  // Tools for providers whose tool loop the host feeds (Gemini, and any
  // extension agent). MCP-discovering providers (claude-code, openai-codex)
  // find these same tools over the SSE MCP server, so they are threaded
  // nothing and their sendMessage call shape is unchanged. Gated on the
  // meta-agent server being up plus a session + workspace, mirroring
  // McpConfigService parity.
  const isToolLoopSession = usesHostSuppliedToolLoop(session.provider);
  // Only a meta-agent session may receive spawn tools. A standard
  // child session (created agentRole='standard' by MetaAgentService) must
  // NOT get spawn tools, otherwise it can spawn grandchildren and trigger
  // exponential recursion. This mirrors claude-code/openai-codex, where only
  // a button-created meta-agent gets the spawn tools over the SSE MCP server
  // and its standard children cannot spawn. Gate tools and persona on the
  // SAME condition so they stay in lockstep.
  const isMetaAgentToolLoopSession =
    isToolLoopSession && session.agentRole === 'meta-agent';
  // A standard (non-meta-agent) session gets the workspace dev toolset so
  // the model can investigate and edit through the SAME simulated tool
  // loop. This mirrors the MCP-discovering providers: a standard session
  // has file tools, only a meta-agent session has orchestration tools.
  // These dispatch host-side and need no MetaAgentService port.
  const isStandardToolLoopSession =
    isToolLoopSession && session.agentRole !== 'meta-agent';
  const toolLoopTools =
    isMetaAgentToolLoopSession &&
    MetaAgentService.getInstance().getPort() !== null &&
    session.id &&
    effectiveWorkspacePath
      ? getMetaAgentOpenAITools()
      : isStandardToolLoopSession && session.id && effectiveWorkspacePath
        ? getDevAgentOpenAITools(
            resolveDevToolScope((session.metadata as Record<string, unknown> | undefined)?.toolScope),
          )
        : undefined;

  // Meta-agent persona for tool-loop providers. The MCP-discovering
  // providers build this same persona internally over their SDK system
  // prompt; a tool-loop provider has no equivalent, so without this it
  // receives ONLY tool schemas and replies as a generic chat assistant
  // ("how would you like to proceed?") instead of proactively setting
  // session meta, surveying worktrees/sessions, and spawning child
  // sessions. We reuse the SAME buildMetaAgentSystemPrompt source (no
  // duplicated persona text), gated strictly on agentRole === 'meta-agent'
  // so a normal Gemini chat session is unaffected. 'codex' tool-reference
  // style renders plain tool names, matching how a tool loop presents tools
  // in its JSON envelope (no `mcp__` SDK prefix).
  // Workflow preset for the meta-agent persona. Read from session metadata
  // (validated) with a 'default' fallback, mirroring how effortLevel is read
  // above. Behavior is byte-identical until something writes
  // metadata.workflowPreset (e.g. via update_session_meta); the 'research'
  // and 'implement-review-test' presets become selectable once it does.
  const rawWorkflowPreset = (session.metadata as Record<string, unknown> | undefined)?.workflowPreset;
  const extensionWorkflowPreset =
    rawWorkflowPreset === 'research' || rawWorkflowPreset === 'implement-review-test'
      ? rawWorkflowPreset
      : 'default';
  const toolLoopSystemPrompt =
    isMetaAgentToolLoopSession
      ? buildMetaAgentSystemPrompt('codex', extensionWorkflowPreset, {
          provider: session.provider,
          model: session.model ?? undefined,
          modelDisplayName: resolveToolLoopModelDisplayName(session.provider, session.model),
        })
      : isStandardToolLoopSession && session.id && effectiveWorkspacePath
        ? buildDevAgentSystemPrompt({
            provider: session.provider,
            model: session.model ?? undefined,
            modelDisplayName: resolveToolLoopModelDisplayName(session.provider, session.model),
          })
        : undefined;

  return { isToolLoopSession, toolLoopTools, toolLoopSystemPrompt };
}
