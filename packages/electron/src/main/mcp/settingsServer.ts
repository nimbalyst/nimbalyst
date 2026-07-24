/**
 * Settings Control tool surface (`settings_*` / `workspace_*` / `appearance_*` / …)
 *
 * Exposes a curated, action-shaped surface for an AI agent to inspect and
 * change Nimbalyst settings on the user's behalf. All mutations route through
 * SettingsControlService which enforces the allow-list, deny-list, rate-limit,
 * and audit logging.
 *
 * MCP consolidation: these tools are served by the unified internal MCP HTTP
 * server (`packages/electron/src/main/mcp/httpServer.ts`) — the settings tools
 * on the `/mcp/host` endpoint (`nimbalyst-host`) and the two tracker-config
 * tools on `/mcp/trackers` per the topology reverse index. This module exports
 * only the tool schemas + an endpoint-agnostic dispatch fn; the standalone HTTP
 * server it used to run was retired in Phase 7.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { SettingsControlService } from "../services/SettingsControlService";

// ─── Tool descriptors ───────────────────────────────────────────────

const TOOLS = [
  {
    name: "settings_get_overview",
    description:
      "Return a curated, redacted snapshot of Nimbalyst settings (app-level + current workspace). NEVER includes API keys, auth tokens, or secrets. Includes Stytch auth state booleans so you can tell whether sync prerequisites are met. Use this before changing anything so you can show the user what's currently set.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "workspace_create",
    description:
      "Create a new project workspace (folder) and optionally open it as a window. Refuses to create on top of a non-empty folder unless force is true; when force is needed, ask the user via AskUserQuestion first and pass force only after confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Absolute path where the workspace folder should live.",
        },
        openAfterCreate: {
          type: "boolean",
          description: "Open the workspace as a window after creation. Default true.",
        },
        force: {
          type: "boolean",
          description: "Allow creating on top of an existing non-empty folder. Only pass after user confirmation.",
        },
      },
      required: ["targetPath"],
    },
  },
  {
    name: "workspace_open",
    description: "Open an existing folder as a project window (focuses if already open).",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute path to an existing folder." },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "sync_set_for_project",
    description:
      "Enable or disable session sync and/or document sync for a specific project. Requires the user to be signed in with Stytch first; if not, returns requiresUserAction='stytch-signin' and you should ask the user to sign in. WARNING: enabling document sync on a project with hundreds of markdown files will trigger a large initial upload -- ask the user to confirm via AskUserQuestion before turning on document sync for unfamiliar/large projects.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute workspace path." },
        enableSessionSync: {
          type: "boolean",
          description: "Set true to add this project to session sync, false to remove. Omit to leave unchanged.",
        },
        enableDocumentSync: {
          type: "boolean",
          description: "Set true to add this project to document sync, false to remove. Omit to leave unchanged.",
        },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "appearance_set_theme",
    description:
      "Change the app theme. Accepts built-in themes (dark, light, system, auto, crystal-dark) or an extension theme in the form 'extensionId:themeId'.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Theme identifier." },
      },
      required: ["theme"],
    },
  },
  {
    name: "appearance_set_completion_sound",
    description: "Enable or disable the sound played when an AI session completes.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "appearance_set_spellcheck",
    description: "Enable or disable Chromium's built-in spellchecker for editors and inputs.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "analytics_set_enabled",
    description: "Enable or disable anonymous usage analytics.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "ai_set_default_model",
    description:
      "Set the default AI model for new sessions, in the form 'provider:model' (e.g. 'claude-code:sonnet'). The provider must already be configured.",
    inputSchema: {
      type: "object",
      properties: { providerModel: { type: "string" } },
      required: ["providerModel"],
    },
  },
  {
    name: "ai_set_preferred_language",
    description:
      "Set the preferred natural language for agent output (used by auto-naming and any prompts that respect it). BCP-47 code or common name (e.g. 'ja', 'en', 'French'). Pass empty string to clear.",
    inputSchema: {
      type: "object",
      properties: { language: { type: "string" } },
      required: ["language"],
    },
  },
  {
    name: "features_toggle",
    description:
      "Toggle an alpha, beta, or developer feature flag by tag. Alpha and developer toggles require Developer Mode to already be enabled; if not, returns requiresUserAction='developer-mode' and you should ask the user to enable it from Settings > Advanced.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", enum: ["alpha", "beta", "developer"] },
        tag: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["bucket", "tag", "enabled"],
    },
  },
  {
    name: "extension_set_enabled",
    description:
      "Enable or disable an installed extension by ID. Does not install or uninstall -- use the nimbalyst-extension-dev tools for that.",
    inputSchema: {
      type: "object",
      properties: {
        extensionId: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["extensionId", "enabled"],
    },
  },
  {
    name: "workspace_set_trust",
    description:
      "Set the agent trust mode for a workspace. Permission modes: 'ask' (smart per-tool permission prompts), 'allow-all' (auto-approve file edits), 'bypass-all' (auto-approve every tool including shell). Set trusted=false to untrust. Bypass-all is powerful -- ask the user to confirm via AskUserQuestion before using it on unfamiliar projects.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute workspace path." },
        trusted: {
          type: "boolean",
          description: "true to grant trust at the given mode, false to revoke trust.",
        },
        mode: {
          type: "string",
          enum: ["ask", "allow-all", "bypass-all"],
          description: "Permission mode when trusted=true. Defaults to 'ask'. Ignored when trusted=false.",
        },
      },
      required: ["workspacePath", "trusted"],
    },
  },
  {
    name: "tracker_set_sync_policy",
    description:
      "Set the sync mode for a tracker type within a workspace. Modes: 'local' (no sync), 'shared' (sync to team), 'hybrid' (per-item).",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        trackerType: { type: "string", description: "Tracker type ID (e.g. 'bug', 'task')." },
        mode: { type: "string", enum: ["local", "shared", "hybrid"] },
      },
      required: ["workspacePath", "trackerType", "mode"],
    },
  },
  {
    name: "tracker_set_issue_key_prefix",
    description:
      "Set the issue key prefix for a workspace (e.g. 'NIM' produces NIM-1, NIM-2). Uppercase letter first, 1-16 chars, A-Z 0-9 _ - only.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        prefix: { type: "string" },
      },
      required: ["workspacePath", "prefix"],
    },
  },
] as const;

// ─── Shared tool surface (served by the unified MCP server) ─────────

/** Tool schemas exposed by the settings surface (`{name, description, inputSchema}`). */
export const settingsToolSchemas = TOOLS as ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: unknown;
}>;

/**
 * Dispatch a settings tool call to SettingsControlService and return the
 * MCP `{content, isError}` shape. `name` may carry the
 * `mcp__nimbalyst-host__` (or `-trackers__`) prefix; it is stripped.
 */
export async function dispatchSettingsTool(
  name: string,
  rawArgs: unknown,
  aiSessionId: string,
  workspaceId: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst-[a-z]+__/, "");
  const args = (rawArgs ?? {}) as Record<string, any>;
  const svc = SettingsControlService.getInstance();

  const respond = (payload: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: typeof payload === "object" && payload !== null && (payload as any).ok === false,
  });

  try {
    switch (toolName) {
      case "settings_get_overview":
        return respond({ ok: true, after: svc.getOverview(workspaceId) });

      case "workspace_create":
        return respond(
          await svc.createWorkspace(aiSessionId, {
            targetPath: args.targetPath,
            openAfterCreate: args.openAfterCreate,
            force: args.force,
          }),
        );

      case "workspace_open":
        return respond(await svc.openWorkspace(aiSessionId, { workspacePath: args.workspacePath }));

      case "sync_set_for_project":
        return respond(
          await svc.setProjectSync(aiSessionId, {
            workspacePath: args.workspacePath,
            enableSessionSync: args.enableSessionSync,
            enableDocumentSync: args.enableDocumentSync,
          }),
        );

      case "appearance_set_theme":
        return respond(await svc.setTheme(aiSessionId, { theme: args.theme }));

      case "appearance_set_completion_sound":
        return respond(await svc.setCompletionSound(aiSessionId, { enabled: !!args.enabled }));

      case "appearance_set_spellcheck":
        return respond(await svc.setSpellcheck(aiSessionId, { enabled: !!args.enabled }));

      case "analytics_set_enabled":
        return respond(await svc.setAnalytics(aiSessionId, { enabled: !!args.enabled }));

      case "ai_set_default_model":
        return respond(
          await svc.setDefaultAIModel(aiSessionId, { providerModel: args.providerModel }),
        );

      case "ai_set_preferred_language":
        return respond(
          await svc.setPreferredAgentLanguage(aiSessionId, { language: args.language ?? "" }),
        );

      case "features_toggle":
        return respond(
          await svc.toggleFeature(aiSessionId, {
            bucket: args.bucket,
            tag: args.tag,
            enabled: !!args.enabled,
          }),
        );

      case "extension_set_enabled":
        return respond(
          await svc.setExtensionEnabled(aiSessionId, {
            extensionId: args.extensionId,
            enabled: !!args.enabled,
          }),
        );

      case "workspace_set_trust":
        return respond(
          await svc.setWorkspaceTrust(aiSessionId, {
            workspacePath: args.workspacePath,
            trusted: !!args.trusted,
            mode: args.mode,
          }),
        );

      case "tracker_set_sync_policy":
        return respond(
          await svc.setTrackerSyncPolicy(aiSessionId, {
            workspacePath: args.workspacePath,
            trackerType: args.trackerType,
            mode: args.mode,
          }),
        );

      case "tracker_set_issue_key_prefix":
        return respond(
          await svc.setIssueKeyPrefix(aiSessionId, {
            workspacePath: args.workspacePath,
            prefix: args.prefix,
          }),
        );

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[Settings MCP] Tool ${toolName} failed:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
