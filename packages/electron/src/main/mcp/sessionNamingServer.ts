/**
 * Session-naming / `update_session_meta` tool surface.
 *
 * MCP consolidation: `update_session_meta` is served by the unified internal MCP
 * HTTP server's eager core (`/mcp/core`, `nimbalyst`). This module exports the
 * dynamic schema builder + an endpoint-agnostic dispatch fn, and keeps the
 * setter-injected session-manager fns (the auto-namer also calls them); the
 * standalone HTTP server it used to run was retired in Phase 7.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Store reference to the session manager functions (set once at startup)
let updateSessionTitleFn:
  | ((sessionId: string, title: string) => Promise<void>)
  | null = null;

let updateSessionMetadataFn:
  | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>)
  | null = null;

let getSessionTagsFn:
  | ((sessionId: string) => Promise<string[]>)
  | null = null;

let getSessionTitleFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

let getSessionPhaseFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

/**
 * Set the update function for session titles (called once at startup)
 */
export function setUpdateSessionTitleFn(
  updateTitleFn: (sessionId: string, title: string) => Promise<void>
) {
  updateSessionTitleFn = updateTitleFn;
}

/**
 * Set the update function for session metadata (called once at startup)
 */
export function setUpdateSessionMetadataFn(
  updateMetadataFn: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>
) {
  updateSessionMetadataFn = updateMetadataFn;
}

/**
 * Set the function to get current tags for a session (called once at startup)
 */
export function setGetSessionTagsFn(
  getTagsFn: (sessionId: string) => Promise<string[]>
) {
  getSessionTagsFn = getTagsFn;
}

/**
 * Set the function to get current title for a session (called once at startup)
 */
export function setGetSessionTitleFn(
  getTitleFn: (sessionId: string) => Promise<string | null>
) {
  getSessionTitleFn = getTitleFn;
}

/**
 * Set the function to get current phase for a session (called once at startup)
 */
export function setGetSessionPhaseFn(
  getPhaseFn: (sessionId: string) => Promise<string | null>
) {
  getSessionPhaseFn = getPhaseFn;
}

// ─── Shared tool surface (served by the unified MCP server) ─────────
//
// `update_session_meta` rides on the eager core (`nimbalyst`) served by the
// unified internal HTTP server's `/mcp/core` endpoint. The dispatch + schema
// builder below are the single implementation; the IPC side effects live in the
// injected fns above.

/**
 * Build the `update_session_meta` tool schema. This eager schema must remain
 * byte-stable for the lifetime of a Claude cache lineage: embedding live
 * workspace tag names, counts, or count-derived ordering here turns ordinary
 * tag updates into a full `tools_changed` cache miss.
 */
export async function buildSessionMetaToolSchemas(_aiSessionId: string): Promise<any[]> {
  return [
    {
      name: "update_session_meta",
      description:
        "Update session metadata. Set name, tags, and phase on the first call; update tags/phase on later calls. Do not rename an already-named session unless the user asks. Returns the full current metadata.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Concise session name (2-5 words), descriptive part first (e.g. "Dark mode implementation"). Set on the first call only, unless the user asks for a rename.',
          },
          add: {
            type: "array",
            items: { type: "string" },
            description: "Tags to add: lowercase hyphen-separated type of work (bug-fix, feature, refactor) and area/module (electron, runtime, ios). Reuse existing workspace tags when known.",
          },
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Tags to remove from the session",
          },
          phase: {
            type: "string",
            enum: ["backlog", "planning", "implementing", "validating", "complete"],
            description:
              'Kanban phase: "planning" for exploration/design, "implementing" for coding, "validating" for testing/review. NEVER set "complete" without explicit user approval — only the user decides when work is complete.',
          },
          workflowPreset: {
            type: "string",
            enum: ["default", "implement-review-test", "research"],
            description:
              'Meta-agent workflow mode: "default" autonomous loop, "implement-review-test" implement/review/test loop in one worktree, "research" decomposes across child sessions. Takes effect next turn.',
          },
        },
      },
    },
  ];
}

/** Snapshot the current session metadata state (uses the injected getter fns). */
async function snapshotSessionMeta(aiSessionId: string): Promise<{ name: string | null; tags: string[]; phase: string | null }> {
  const name = getSessionTitleFn ? await getSessionTitleFn(aiSessionId) : null;
  const tags: string[] = getSessionTagsFn ? await getSessionTagsFn(aiSessionId) : [];
  const phase = getSessionPhaseFn ? await getSessionPhaseFn(aiSessionId) : null;
  return { name, tags, phase };
}

/** Build the structured JSON response with before/after state for the widget. */
function buildSessionMetaResponse(
  notes: string[],
  before: { name: string | null; tags: string[]; phase: string | null },
  after: { name: string | null; tags: string[]; phase: string | null },
): string {
  const parts = [...notes];
  parts.push(`Name: ${after.name || '(not set)'}`);
  parts.push(`Tags: ${after.tags.length > 0 ? after.tags.map(t => `#${t}`).join(', ') : '(none)'}`);
  parts.push(`Phase: ${after.phase || '(not set)'}`);
  const summary = parts.join('\n');
  return JSON.stringify({ summary, before, after });
}

/**
 * Dispatch `update_session_meta` and return the MCP `{content, isError}` shape.
 * `name` may carry the `mcp__nimbalyst__` prefix; it is stripped. The injected
 * fns perform the DB writes + IPC broadcasts (session-updated / title-updated),
 * so the kanban/UI still updates.
 */
export async function dispatchSessionMetaTool(
  name: string,
  args: Record<string, any> | undefined,
  aiSessionId: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst(-session-naming)?__/, "");

  try {
    if (toolName === "update_session_meta") {
      const sessionName = args?.name as string | undefined;
      const addTags = Array.isArray(args?.add) ? args.add as string[] : typeof args?.add === 'string' ? [args.add] : undefined;
      const removeTags = Array.isArray(args?.remove) ? args.remove as string[] : typeof args?.remove === 'string' ? [args.remove] : undefined;
      const phase = args?.phase as string | undefined;
      const rawWorkflowPreset = args?.workflowPreset;
      const workflowPreset =
        rawWorkflowPreset === 'default' ||
        rawWorkflowPreset === 'implement-review-test' ||
        rawWorkflowPreset === 'research'
          ? (rawWorkflowPreset as string)
          : undefined;
      if (rawWorkflowPreset !== undefined && workflowPreset === undefined) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: "workflowPreset" must be one of "default", "implement-review-test", "research".',
            },
          ],
          isError: true,
        };
      }

      // Require at least one parameter
      if (!sessionName && !addTags?.length && !removeTags?.length && !phase && !workflowPreset) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: At least one of "name", "add", "remove", "phase", or "workflowPreset" must be provided.',
            },
          ],
          isError: true,
        };
      }

      // Capture state before changes for the widget transition display
      const before = await snapshotSessionMeta(aiSessionId);
      const notes: string[] = [];

      // Handle name (write-once)
      if (sessionName) {
        if (typeof sessionName !== "string") {
          return {
            content: [
              {
                type: "text",
                text: 'Error: "name" must be a string.',
              },
            ],
            isError: true,
          };
        }

        if (sessionName.length > 100) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Session name too long (${sessionName.length} chars, max 100)`,
              },
            ],
            isError: true,
          };
        }

        try {
          await updateSessionTitleFn!(aiSessionId, sessionName);
          notes.push(`Set name: "${sessionName}"`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          console.error("[Session Naming MCP] Failed to update session title:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating session title: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Handle tags (add/remove)
      if (addTags?.length || removeTags?.length) {
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const currentTags: string[] = getSessionTagsFn
            ? await getSessionTagsFn(aiSessionId)
            : [];

          let newTags = [...currentTags];
          if (removeTags?.length) {
            const removeSet = new Set(removeTags);
            newTags = newTags.filter(t => !removeSet.has(t));
          }
          if (addTags?.length) {
            for (const tag of addTags) {
              if (!newTags.includes(tag)) {
                newTags.push(tag);
              }
            }
          }

          const metadataUpdate: Record<string, unknown> = { tags: newTags };
          if (phase) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;

          await updateSessionMetadataFn(aiSessionId, metadataUpdate);

          if (addTags?.length) notes.push(`Added tags: ${addTags.map(t => `#${t}`).join(', ')}`);
          if (removeTags?.length) notes.push(`Removed tags: ${removeTags.map(t => `#${t}`).join(', ')}`);
          if (phase) notes.push(`Set phase: ${phase}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update tags:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating tags: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      } else if (phase || workflowPreset) {
        // Metadata-only update (no tag changes): phase and/or workflowPreset
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const metadataUpdate: Record<string, unknown> = {};
          if (phase) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;
          await updateSessionMetadataFn(aiSessionId, metadataUpdate);
          if (phase) notes.push(`Set phase: ${phase}`);
          if (workflowPreset) notes.push(`Set workflow preset: ${workflowPreset}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update session metadata:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating session metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Build structured response with before/after for widget
      const after = await snapshotSessionMeta(aiSessionId);
      const response = buildSessionMetaResponse(notes, before, after);
      return {
        content: [{ type: "text", text: response }],
        isError: false,
      };
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[SessionMeta MCP] Tool "${name}" failed:`, error);
    console.error(`[SessionMeta MCP] Tool args:`, JSON.stringify(args).slice(0, 500));
    throw error;
  }
}
