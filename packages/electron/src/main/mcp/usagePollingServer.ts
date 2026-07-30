/**
 * Provider usage-polling tool surface (`get_provider_usage`).
 *
 * Claude Code and Codex usage are already tracked (ClaudeUsageService,
 * CodexUsageService) and shown in Nimbalyst's own UI via renderer-only IPC
 * channels (claude-usage:get, codex-usage:get) -- but nothing wired that data
 * to a running AI session. This server closes that gap: it exposes the same
 * cached/refreshed usage data those IPC handlers already produce, plus a
 * matching (much more limited -- see OllamaUsageService's module doc for why)
 * reading for the local Ollama Cloud brain-swap route, through one MCP tool a
 * session can call directly.
 *
 * Follows the sessionContextServer.ts pattern: exports a tool-schema array +
 * an endpoint-agnostic dispatch fn, folded into the unified `/mcp/host`
 * endpoint (deferred load -- this is rarely needed mid-task, not something to
 * pay for on every session).
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { claudeUsageService, ClaudeUsageData } from "../services/ClaudeUsageService";
import { codexUsageService, CodexUsageData } from "../services/CodexUsageService";
import { ollamaUsageService, OllamaUsageData } from "../services/OllamaUsageService";

// ─── Formatting ─────────────────────────────────────────────────────

function formatRelativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatResetsAt(resetsAt: string | null): string {
  if (!resetsAt) return "";
  try {
    return ` (resets ${new Date(resetsAt).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })})`;
  } catch {
    return "";
  }
}

function formatClaudeUsage(data: ClaudeUsageData): string {
  if (data.error) {
    return `Claude Code usage: unavailable -- ${data.error}`;
  }
  const lines: string[] = ["Claude Code usage:"];
  lines.push(
    `  5-hour window: ${data.fiveHour.utilization}%${formatResetsAt(data.fiveHour.resetsAt)}`
  );
  lines.push(
    `  7-day window: ${data.sevenDay.utilization}%${formatResetsAt(data.sevenDay.resetsAt)}`
  );
  if (data.sevenDayOpus) {
    lines.push(
      `  7-day Opus window: ${data.sevenDayOpus.utilization}%${formatResetsAt(data.sevenDayOpus.resetsAt)}`
    );
  }
  lines.push(`  Last updated: ${formatRelativeAge(data.lastUpdated)}`);
  return lines.join("\n");
}

function formatCodexUsage(data: CodexUsageData): string {
  if (data.error) {
    return `OpenAI Codex usage: unavailable -- ${data.error}`;
  }
  const lines: string[] = ["OpenAI Codex usage:"];
  if (data.limitsAvailable === false || data.limits.length === 0) {
    if (data.tokenUsage) {
      lines.push(
        `  Rate limits unavailable (source: ${data.source ?? "unknown"}); token usage instead -- ` +
        `total: ${data.tokenUsage.totalTokens.toLocaleString()}` +
        (data.tokenUsage.lastTokens !== null ? `, last turn: ${data.tokenUsage.lastTokens.toLocaleString()}` : "")
      );
    } else {
      lines.push("  No usage data available yet.");
    }
  } else {
    for (const limit of data.limits) {
      const label = limit.name ? `${limit.name} (${limit.id})` : limit.id;
      lines.push(`  ${label}${limit.planType ? ` [${limit.planType}]` : ""}:`);
      for (const window of limit.windows) {
        const durationLabel = window.windowDurationMins
          ? `${window.windowDurationMins}min`
          : window.slot;
        lines.push(`    ${durationLabel}: ${window.usedPercent}%${formatResetsAt(window.resetsAt)}`);
      }
      if (limit.credits && !limit.credits.unlimited) {
        lines.push(`    Credits: ${limit.credits.hasCredits ? (limit.credits.balance ?? "available") : "none"}`);
      }
    }
  }
  lines.push(`  Last updated: ${formatRelativeAge(data.lastUpdated)}`);
  return lines.join("\n");
}

function formatOllamaUsage(data: OllamaUsageData): string {
  const lines: string[] = ["Ollama Cloud (local brain-swap proxy):"];
  lines.push(`  Local proxy reachable: ${data.proxyReachable ? "yes" : "no"}`);
  if (data.proxyReachable) {
    lines.push(
      data.configuredAliases.length > 0
        ? `  Configured aliases (${data.configuredAliases.length}): ${data.configuredAliases.join(", ")}`
        : "  No aliases configured on the proxy."
    );
  }
  lines.push(`  Note: ${data.note}`);
  lines.push(
    `  Plan tiers (static reference): ${data.planTiers
      .map((t) => `${t.tier}=${t.concurrentCloudModels} concurrent / ${t.weeklyGpuQuota} weekly GPU`)
      .join("; ")}`
  );
  lines.push(`  Last checked: ${formatRelativeAge(data.lastUpdated)}`);
  return lines.join("\n");
}

// ─── Tool handler ───────────────────────────────────────────────────

type ProviderKey = "claude-code" | "openai-codex" | "ollama";
const ALL_PROVIDERS: ProviderKey[] = ["claude-code", "openai-codex", "ollama"];

async function handleGetProviderUsage(
  provider: ProviderKey | undefined,
  forceRefresh: boolean
): Promise<string> {
  const targets = provider ? [provider] : ALL_PROVIDERS;
  const sections: string[] = [];

  for (const target of targets) {
    switch (target) {
      case "claude-code": {
        await claudeUsageService.recordActivity();
        const data = forceRefresh
          ? await claudeUsageService.refresh()
          : claudeUsageService.getCachedUsage() ?? (await claudeUsageService.refresh());
        sections.push(formatClaudeUsage(data));
        break;
      }
      case "openai-codex": {
        await codexUsageService.recordActivity();
        const data = forceRefresh
          ? await codexUsageService.refresh()
          : codexUsageService.getCachedUsage() ?? (await codexUsageService.refresh());
        sections.push(formatCodexUsage(data));
        break;
      }
      case "ollama": {
        const data = await ollamaUsageService.getUsage(forceRefresh);
        sections.push(formatOllamaUsage(data));
        break;
      }
    }
  }

  return sections.join("\n\n");
}

// ─── MCP server surface ─────────────────────────────────────────────

export const USAGE_POLLING_TOOL_SCHEMAS = [
  {
    name: "get_provider_usage",
    description:
      "Get current usage/rate-limit status for an AI provider: Claude Code subscription usage " +
      "(5-hour and 7-day rolling utilization), OpenAI Codex usage (rate-limit windows or token " +
      "counts), or the local Ollama Cloud brain-swap route (proxy health + configured aliases -- " +
      "Ollama Cloud has no account-level usage API, so no live utilization number exists for it). " +
      "Returns cached data by default, refreshed roughly every 30 minutes in the background for " +
      "Claude/Codex once this tool has been called at least once in the session; pass forceRefresh " +
      "for a live read.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["claude-code", "openai-codex", "ollama"],
          description:
            "Which provider's usage to check. Omit to get a combined report for all three.",
        },
        forceRefresh: {
          type: "boolean",
          description:
            "Force a live refresh instead of using cached data (default false).",
        },
      },
      required: [],
    },
  },
];

/**
 * Dispatch a usage-polling tool call and return the MCP `{content, isError}`
 * shape. `name` may carry the `mcp__nimbalyst-host__` (or legacy) prefix; it
 * is stripped.
 */
export async function dispatchUsagePollingTool(
  name: string,
  args: Record<string, any> | undefined
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, "");

  try {
    switch (toolName) {
      case "get_provider_usage": {
        const rawProvider = args?.provider as string | undefined;
        const provider =
          rawProvider === "claude-code" || rawProvider === "openai-codex" || rawProvider === "ollama"
            ? rawProvider
            : undefined;
        if (rawProvider && !provider) {
          return {
            content: [{
              type: "text",
              text: `Error: Invalid provider "${rawProvider}". Valid values: ${ALL_PROVIDERS.join(", ")}`,
            }],
            isError: true,
          };
        }
        const forceRefresh = Boolean(args?.forceRefresh);
        const result = await handleGetProviderUsage(provider, forceRefresh);
        return { content: [{ type: "text", text: result }], isError: false };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[Usage Polling MCP] Tool ${toolName} failed:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
}
