import { BrowserWindow } from "electron";
import { PAGE_TOOL_CONTRACT, PAGE_TOOL_DESKTOP_PROJECT_ARG } from "@nimbalyst/collab-protocol";
import { findWindowIdForWorkspacePath } from "../mcpWorkspaceResolver";
import { getMostRecentlyFocusedWorkspaceWindow } from "../../window/WindowManager";
import { requestFromRenderer } from "../rendererRequest";
import { teamPageLocalLinkWarning } from "./teamPageLocalLinks";
import { refuseOtherProjectWrite, routePageRead } from "./pageProjectReads";

type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
};

/**
 * Page tree MCP tools for Wiki mode, Team and Personal sections: list the
 * tree, create pages, move and reorder pages, typed pages and placed types,
 * rename, delete, Set type, and a plain page's own fields. Folders are pages in the page tree; the
 * `folder` names on the wire (`parentFolderId`, `folderPath`, kind 'folder')
 * stay for callers that already use them and address pages.
 *
 * The docs sessions that own the tree live in the renderer, so each tool
 * round-trips to a window over a unique resultChannel and the renderer
 * (`renderer/services/pageTreeTools/pageTreeToolHandlers.ts`) replies once.
 */

// Registration hits the TeamSyncProvider (a WebSocket send); Set type also
// publishes an item and reads its body back with retries.
const ROUND_TRIP_TIMEOUT_MS = 15000;
const SLOW_ROUND_TRIP_TIMEOUT_MS = 60000;

const SECTION = {
  type: "string",
  enum: ["team", "personal"],
  description: "Wiki section. Default 'team'. 'personal' is the Local section: markdown files in this project's wiki folder (nimbalyst-local/wiki unless .nimbalyst/local-wiki.json names another), with no account needed.",
};
const PARENT_KIND = {
  type: "string",
  enum: ["page", "item"],
  description: "What the parent id names: a page, or a typed page ('item'). Inferred from the id when omitted.",
};
/** listPages paging and filters, shaped as the remote server takes them; without them an agent never sees past the first page. */
const { root, maxDepth, kinds, limit, cursor, projection } = PAGE_TOOL_CONTRACT.find((tool) => tool.name === "listPages")!.inputSchema.properties;

const BESIDE = "Tree node id from listPages (e.g. 'document:<id>', 'item:<id>', 'type:<id>'), or a bare page id, issue key or type id.";

export function getCollabIndexToolSchemas() {
  const tools: Array<{ name: string; description: string; inputSchema: any }> = [
    {
      name: "listPages",
      description:
        "List a Wiki section as a paginated tree (100 nodes by default, at most 500): while truncated is true, call again with nextCursor and the same arguments; root, maxDepth and kinds narrow the listing. Pages, placed types and typed pages, each with nodeId, kind, id, title, parentNodeId, depth, sortOrder and the https link to write in page content (types also a viewLink); pages carry the uri to read and edit their body, typed pages their issueKey and whether they are placed outside their type. The team section lists the current project and names the team's other projects; pass one as `project` to list it.",
      inputSchema: {
        type: "object",
        properties: { section: SECTION, root, maxDepth, kinds, limit, cursor, projection, project: PAGE_TOOL_DESKTOP_PROJECT_ARG },
      },
    },
    {
      name: "searchPages",
      description:
        "Search a Wiki section by the text in page bodies and titles: pages, typed pages and type pages. Every word must match; the last also matches as a word start. Returns the best matches first, each with kind, id, title, the uri to read with readCollabDoc, the https link to write in page content, and a snippet of the matching text. Use it to find what the pages say about a topic (for example what was decided about X) instead of reading pages one by one. Pass `project` to search another project of the team.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to find." },
          section: SECTION,
          limit: { type: "number", description: "At most this many results (default 20, at most 50)." },
          project: PAGE_TOOL_DESKTOP_PROJECT_ARG,
        },
        required: ["query"],
      },
    },
    {
      name: "createSharedDoc",
      description:
        "Create a page in the Wiki, under a page, under a typed page, or at the top of the section. Returns the documentId, the uri of its body and the https link to it.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          title: { type: "string", description: "The page title, a bare name (no parent path, no '.md')." },
          documentType: {
            type: "string",
            description:
              "The page's editor. Defaults to 'markdown'. Team pages can also be 'excalidraw' (a drawing), 'mindmap', 'datamodel' (Prisma schema), 'mockup.html', 'canvas', 'csv', 'calc.md', 'slides.md', 'ipynb', 'namenym' or 'code', when that editor's extension is installed. Local (personal) pages are markdown only.",
          },
          parentFolderId: { type: "string", description: "Parent page id, or typed page id / issue key. Omit for the top of the section." },
          parentKind: PARENT_KIND,
          folderPath: { type: "string", description: "Parent by titles ('Architecture/Overview'); missing pages are created empty. Takes precedence over parentFolderId." },
          initialContent: {
            type: "string",
            description:
              "The page's content in its editor's file format: markdown for a markdown page, the .excalidraw JSON for a drawing, the .prisma text for a data model, and so on. To bring in an existing file, use importFileToPages instead.",
          },
          before: { type: "string", description: `Place the new page just before this sibling. ${BESIDE}` },
          after: { type: "string", description: `Place the new page just after this sibling. ${BESIDE}` },
        },
        required: ["title"],
      },
    },
    {
      name: "importFileToPages",
      description:
        "Copy a file from this computer into the Wiki as a page: a drawing, mind map, data model, mockup, spreadsheet, slides, notebook or markdown file becomes a page of that type that teammates can open. Use it instead of linking a file path from a Team page, which teammates cannot open. Returns the documentId, the uri and the https link to it.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path of the file to copy. Its extension picks the page type." },
          section: SECTION,
          title: { type: "string", description: "The page title; the file name without its extension when omitted." },
          parentFolderId: { type: "string", description: "Parent page id. Omit for the top of the section. Not a typed page." },
          folderPath: { type: "string", description: "Parent by titles ('Architecture/Overview'); missing pages are created empty. Takes precedence over parentFolderId." },
          before: { type: "string", description: `Place the new page just before this sibling. ${BESIDE}` },
          after: { type: "string", description: `Place the new page just after this sibling. ${BESIDE}` },
        },
        required: ["filePath"],
      },
    },
    {
      name: "createSharedFolder",
      description: "Create an empty page that will hold child pages (same as createSharedDoc with no body). Returns its page id as folderId.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          name: { type: "string", description: "The page title, a bare name." },
          parentFolderId: { type: "string", description: "Parent page id, or typed page id / issue key. Omit for the top of the section." },
          parentKind: PARENT_KIND,
          folderPath: { type: "string", description: "The PARENT by titles ('A/B'); missing pages are created. Takes precedence over parentFolderId." },
        },
        required: ["name"],
      },
    },
    {
      name: "moveSharedItem",
      description:
        "Move or reorder a node in the Wiki tree: a page (kind 'doc', 'folder' or 'page'), a typed page ('item': places it under a page or typed page, or back under its type with underType), or a type ('type': Place type, or move its placement). Give a new parent, or before/after a sibling to reorder. Refuses a move that would put a node inside itself.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          itemId: { type: "string", description: "Page id, typed page id or issue key, or type id." },
          kind: { type: "string", enum: ["doc", "folder", "page", "item", "type"], description: "What itemId names. 'doc', 'folder' and 'page' all mean a page." },
          newParentFolderId: { type: "string", description: "New parent page id, or typed page id / issue key. Omit (or null) for the top of the section." },
          parentKind: PARENT_KIND,
          folderPath: { type: "string", description: "New parent by titles ('A/B'); missing pages are created. Takes precedence over newParentFolderId." },
          before: { type: "string", description: `Move just before this sibling (its parent becomes the parent). ${BESIDE}` },
          after: { type: "string", description: `Move just after this sibling. ${BESIDE}` },
          underType: { type: "boolean", description: "Typed page only: send it back under its type." },
        },
        required: ["itemId", "kind"],
      },
    },
    {
      name: "renameSharedItem",
      description: "Rename a page. Stores the bare name. A typed page is renamed with tracker_update (title).",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          itemId: { type: "string", description: "The page id." },
          kind: { type: "string", enum: ["doc", "folder", "page"], description: "Always a page; kept for older callers." },
          newName: { type: "string", description: "The new title, a bare name (no parent path)." },
        },
        required: ["itemId", "newName"],
      },
    },
    {
      name: "deleteSharedItem",
      description:
        "Delete a page by moving it to Trash, where a person can restore it. kind 'folder' moves the page with every page under it to Trash; kind 'doc' moves only a page that has no children to Trash. Ask a person before deleting a page someone else wrote.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          itemId: { type: "string", description: "The page id." },
          kind: { type: "string", enum: ["doc", "folder"], description: "'folder' for the page with its whole subtree, 'doc' for a page with no children." },
        },
        required: ["itemId", "kind"],
      },
    },
    {
      name: "setPageType",
      description:
        "Give a plain page a type in place (the page menu's Set type): it becomes a typed page of that type with the same title, body, position and children, and the plain page goes to Trash once the copy is verified. Returns the new item id.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          pageId: { type: "string", description: "The plain page's id." },
          typeId: { type: "string", description: "A tracker type of the same section (team types for Team, personal types for Personal)." },
        },
        required: ["pageId", "typeId"],
      },
    },
    {
      name: "setPageFields",
      description:
        "Set a plain page's own fields: owner (a member's email from findOrgMembers), status (draft, current or outdated), summary (one line, at most 280 characters) and tags. Only the fields you pass change; null clears one. A value that does not fit is ignored, so the reply names the fields the page has now. listPages shows them on each page. A typed page's fields are set with tracker_update.",
      inputSchema: {
        type: "object",
        properties: {
          section: SECTION,
          itemId: { type: "string", description: "The page id." },
          fields: {
            type: "object",
            description: "The fields to change. Null clears one.",
            properties: {
              owner: { type: ["string", "null"], description: "The owner's email." },
              status: { type: ["string", "null"], enum: ["draft", "current", "outdated", null] },
              summary: { type: ["string", "null"], description: "One line: what the page is for." },
              tags: { type: ["array", "null"], items: { type: "string" } },
            },
          },
        },
        required: ["itemId", "fields"],
      },
    },
  ];

  return tools;
}

/**
 * Resolve the renderer window that owns the Wiki sessions for this call.
 * Prefers the session's workspace window; falls back to the most recently
 * focused workspace window, mirroring what the person sees.
 */
async function resolveTargetWindow(
  workspacePath: string | undefined
): Promise<BrowserWindow | null> {
  if (workspacePath) {
    const windowId = await findWindowIdForWorkspacePath(workspacePath);
    if (windowId) {
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        return win;
      }
    }
  }
  const focused = getMostRecentlyFocusedWorkspaceWindow();
  return focused && !focused.isDestroyed() ? focused : null;
}

type RendererResult = { success: boolean; error?: string; [key: string]: unknown };

/** Send `payload` to `channel` on the target window and wait for the one-shot reply. */
async function roundTripToRenderer(
  window: BrowserWindow,
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<RendererResult> {
  const outcome = await requestFromRenderer<RendererResult | undefined>(window, channel, payload, { timeoutMs });
  if (outcome.status === "timedOut") {
    return { success: false, error: "Timed out while waiting for the renderer to update the page tree." };
  }
  return outcome.response ?? { success: false, error: "No result returned from renderer." };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

const PAGE_KINDS = new Set(["doc", "folder", "page"]);

/** Argument checks done before reaching the renderer; null when the call is well formed. */
function invalidArguments(tool: string, args: any): string | null {
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  switch (tool) {
    case "createSharedDoc":
      return nonEmpty(args?.title) ? null : "createSharedDoc requires a non-empty title.";
    case "createSharedFolder":
      return nonEmpty(args?.name) ? null : "createSharedFolder requires a non-empty name.";
    case "importFileToPages":
      return nonEmpty(args?.filePath) ? null : "importFileToPages requires a filePath.";
    case "moveSharedItem":
      if (!nonEmpty(args?.itemId)) return "moveSharedItem requires an itemId.";
      return PAGE_KINDS.has(args?.kind) || args?.kind === "item" || args?.kind === "type"
        ? null
        : "moveSharedItem requires kind 'doc', 'folder', 'page', 'item' or 'type'.";
    case "renameSharedItem":
      if (!nonEmpty(args?.itemId)) return "renameSharedItem requires an itemId.";
      return nonEmpty(args?.newName) ? null : "renameSharedItem requires a non-empty newName.";
    case "deleteSharedItem":
      if (!nonEmpty(args?.itemId)) return "deleteSharedItem requires an itemId.";
      return args?.kind === "doc" || args?.kind === "folder" ? null : "deleteSharedItem requires kind 'doc' or 'folder'.";
    case "setPageType":
      return nonEmpty(args?.pageId) && nonEmpty(args?.typeId) ? null : "setPageType requires pageId and typeId.";
    case "searchPages":
      return nonEmpty(args?.query) ? null : "searchPages requires a non-empty query.";
    case "setPageFields":
      if (!nonEmpty(args?.itemId)) return "setPageFields requires an itemId.";
      return args?.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
        ? null
        : "setPageFields requires a fields object.";
    default:
      return null;
  }
}

function describeSuccess(tool: string, args: any, result: RendererResult): string {
  const { success: _success, warning, ...rest } = result;
  const note = typeof warning === "string" ? ` ${warning}` : "";
  switch (tool) {
    case "listPages":
      return JSON.stringify(rest);
    case "createSharedDoc": {
      const localLinks = typeof result.uri === "string" ? teamPageLocalLinkWarning(result.uri, [args.initialContent]) : null;
      return `Created page "${args.title}" (documentId: ${result.documentId}${result.uri ? `, uri: ${result.uri}` : ""}${result.link ? `, link: ${result.link}` : ""}).${note}${localLinks ? `\n\n${localLinks}` : ""}`;
    }
    case "importFileToPages":
      return `Imported ${args.filePath} as a page (documentId: ${result.documentId}${result.uri ? `, uri: ${result.uri}` : ""}${result.link ? `, link: ${result.link}` : ""}).${note}`;
    case "createSharedFolder":
      return `Created page "${args.name}" (folderId: ${result.documentId}${result.uri ? `, uri: ${result.uri}` : ""}${result.link ? `, link: ${result.link}` : ""}).${note}`;
    case "moveSharedItem":
      return result.outcome === "unchanged" ? `${args.itemId} is already there.` : `Moved ${args.itemId}.`;
    case "renameSharedItem":
      return `Renamed page ${args.itemId} to "${args.newName}".`;
    case "deleteSharedItem":
      return typeof result.removedCount === "number"
        ? `Deleted page ${args.itemId} and the pages under it (${result.removedCount} page(s)).`
        : `Deleted page ${args.itemId}.`;
    case "setPageType":
      return `Page ${args.pageId} is now a ${args.typeId}${result.itemId ? ` (item id: ${result.itemId})` : ""}.`;
    case "setPageFields":
      return `Page ${args.itemId} fields: ${JSON.stringify(result.fields ?? {})}.`;
    default:
      return JSON.stringify(rest);
  }
}

const TOOL_NAMES = new Set([
  "listPages",
  "searchPages",
  "createSharedDoc",
  "createSharedFolder",
  "importFileToPages",
  "moveSharedItem",
  "renameSharedItem",
  "deleteSharedItem",
  "setPageType",
  "setPageFields",
]);

/** Run a tool on the window's sessions; `extra` is merged into what the renderer answered. */
async function runInRenderer(
  tool: string,
  args: any,
  workspacePath: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const window = await resolveTargetWindow(workspacePath);
  if (!window) return errorResult("Error: No open workspace window available for the Wiki.");

  const payload = { ...(args ?? {}), ...(workspacePath ? { workspacePath } : {}) };
  delete (payload as { resultChannel?: unknown }).resultChannel;
  const timeout = tool === "setPageType" || tool === "createSharedDoc" || tool === "importFileToPages" ? SLOW_ROUND_TRIP_TIMEOUT_MS : ROUND_TRIP_TIMEOUT_MS;
  const result = await roundTripToRenderer(window, `mcp:${tool}`, payload, timeout);
  if (!result.success) return errorResult(`${tool} failed: ${result.error || "Unknown error"}`);
  return textResult(describeSuccess(tool, args, { ...result, ...extra }));
}

async function runPageTreeTool(tool: string, args: any, workspacePath: string | undefined): Promise<McpToolResult> {
  const invalid = invalidArguments(tool, args);
  if (invalid) return errorResult(`Error: ${invalid}`);
  // listPages and searchPages read another project when `project` names one; writes stay in this one.
  if (tool === "listPages" || tool === "searchPages") {
    return routePageRead(tool, args, workspacePath, (localArgs, extra) => runInRenderer(tool, localArgs, workspacePath, extra));
  }
  const refused = await refuseOtherProjectWrite(tool, args, workspacePath);
  if (refused) return errorResult(`Error: ${refused}`);
  return runInRenderer(tool, args, workspacePath);
}

/** Dispatch for every page tree tool; null for a name this module does not own. */
export function handleCollabIndexTool(
  tool: string,
  args: any,
  workspacePath: string | undefined,
): Promise<McpToolResult> | null {
  return TOOL_NAMES.has(tool) ? runPageTreeTool(tool, args, workspacePath) : null;
}

export const handleListPages = (args: any, workspacePath: string | undefined) => runPageTreeTool("listPages", args, workspacePath);
export const handleSearchPages = (args: any, workspacePath: string | undefined) => runPageTreeTool("searchPages", args, workspacePath);
export const handleCreateSharedDoc = (args: any, workspacePath: string | undefined) => runPageTreeTool("createSharedDoc", args, workspacePath);
export const handleImportFileToPages = (args: any, workspacePath: string | undefined) => runPageTreeTool("importFileToPages", args, workspacePath);
export const handleCreateSharedFolder = (args: any, workspacePath: string | undefined) => runPageTreeTool("createSharedFolder", args, workspacePath);
export const handleMoveSharedItem = (args: any, workspacePath: string | undefined) => runPageTreeTool("moveSharedItem", args, workspacePath);
export const handleRenameSharedItem = (args: any, workspacePath: string | undefined) => runPageTreeTool("renameSharedItem", args, workspacePath);
export const handleDeleteSharedItem = (args: any, workspacePath: string | undefined) => runPageTreeTool("deleteSharedItem", args, workspacePath);
export const handleSetPageType = (args: any, workspacePath: string | undefined) => runPageTreeTool("setPageType", args, workspacePath);
export const handleSetPageFields = (args: any, workspacePath: string | undefined) => runPageTreeTool("setPageFields", args, workspacePath);
