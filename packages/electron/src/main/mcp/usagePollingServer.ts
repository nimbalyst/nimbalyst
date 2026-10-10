/** Read-only Ollama usage tools backed by the same cache as the meter. */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ollamaUsageService } from '../services/OllamaUsageService';

export const USAGE_POLLING_TOOL_SCHEMAS = [
  {
    name: 'scrape_ollama_usage',
    description: 'Read normalized Ollama account usage from the shared cache or refresh it. Never opens sign-in UI; connect the account in Settings first. Workspace identity is supplied by the host.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { forceRefresh: { type: 'boolean', description: 'Refresh instead of using the cached snapshot.' } },
      required: [],
    },
  },
  {
    name: 'get_provider_usage',
    description: 'Read signed-in Ollama account usage: plan allowance, extra-credit balance, exact provider resets and this-week model calls. Missing values remain unavailable. This surface currently supports Ollama only and never opens sign-in UI.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        provider: { type: 'string', enum: ['ollama'], description: 'The account usage provider.' },
        forceRefresh: { type: 'boolean', description: 'Refresh instead of using the cached snapshot.' },
      },
      required: ['provider'],
    },
  },
];

export async function dispatchUsagePollingTool(
  name: string,
  args: Record<string, unknown> | undefined,
  workspacePath: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, '');
  if (!USAGE_POLLING_TOOL_SCHEMAS.some(tool => tool.name === toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const failure = (error: string) => ({ content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true });
  const allowed = toolName === 'get_provider_usage' ? ['provider', 'forceRefresh'] : ['forceRefresh'];
  if ((args && Object.keys(args).some(key => !allowed.includes(key)))
      || (args?.forceRefresh !== undefined && typeof args.forceRefresh !== 'boolean')
      || (toolName === 'get_provider_usage' && args?.provider !== 'ollama')) {
    return failure('Invalid usage request. Use the declared provider and refresh fields only.');
  }
  if (!workspacePath?.trim()) return failure('Host workspace is required.');

  try {
    const data = await ollamaUsageService.getUsage(workspacePath, args?.forceRefresh === true);
    const modelCountsAvailable = data.modelCountsPeriod === 'this-week' && data.weekly?.modelCountsAvailable === true;
    // Explicit projection: no browser account identifiers, credential bindings,
    // HTML, cookies, URL, caller script or workspace override cross this surface.
    const normalized = {
      source: data.source,
      authStatus: data.authStatus,
      limitsAvailable: data.limitsAvailable,
      limitsUnavailableReason: data.limitsUnavailableReason,
      plan: data.plan,
      creditBalanceUSD: data.creditBalanceUSD,
      session: data.session ? { utilization: data.session.utilization, resetsAt: data.session.resetsAt } : undefined,
      weekly: data.weekly ? {
        utilization: data.weekly.utilization, resetsAt: data.weekly.resetsAt,
        modelCountsAvailable, models: modelCountsAvailable ? data.weekly.models : undefined,
      } : undefined,
      modelCountsPeriod: modelCountsAvailable ? 'this-week' : undefined,
      lastUpdated: data.lastUpdated,
      error: data.error,
    };
    return { content: [{ type: 'text', text: JSON.stringify(normalized) }], isError: false };
  } catch {
    return failure('Ollama usage is unavailable. Check account sign-in and try again.');
  }
}
