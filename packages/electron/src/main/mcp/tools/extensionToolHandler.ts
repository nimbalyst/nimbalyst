import { BrowserWindow, ipcMain } from "electron";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { findWindowIdForWorkspacePath, getAvailableExtensionTools, documentStateBySession } from "../mcpWorkspaceResolver";

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export async function handleExtensionTool(
  toolName: string,
  originalName: string,
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  // Check if this is an extension tool - use session-specific state
  const currentDocState = sessionId
    ? documentStateBySession.get(sessionId)
    : undefined;
  const extensionTools = await getAvailableExtensionTools(
    workspacePath,
    currentDocState?.filePath
  );

  // Tool names may have been sanitized (dots replaced with underscores) for
  // providers that don't accept dots. Try the incoming name first, then
  // fall back to reversing common sanitization patterns.
  let extensionTool = extensionTools.find((t) => t.name === toolName);
  if (!extensionTool) {
    // Try matching with dots restored (e.g., "automations_list" -> "automations.list")
    // Extension tools use "prefix.action" format, so try replacing the first
    // underscore after a namespace-like prefix with a dot
    for (const tool of extensionTools) {
      if (tool.name.includes('.') && tool.name.replace(/\./g, '_') === toolName) {
        extensionTool = tool;
        break;
      }
    }
  }
  if (!extensionTool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${originalName}`);
  }

  // Execute extension tool via IPC to renderer
  if (!workspacePath) {
    return {
      content: [
        { type: "text", text: `Error: workspacePath is required to execute extension tools` },
      ],
      isError: true,
    };
  }

  // Find the correct window for this workspace (resolves worktree paths to parent project)
  const windowId = await findWindowIdForWorkspacePath(workspacePath);
  if (!windowId) {
    return {
      content: [
        { type: "text", text: `Error: No window found for workspace: ${workspacePath}` },
      ],
      isError: true,
    };
  }

  const targetWindow = BrowserWindow.fromId(windowId);
  if (!targetWindow) {
    return {
      content: [{ type: "text", text: `Error: Window no longer exists` }],
      isError: true,
    };
  }

  // Create a unique channel for the result
  const resultChannel = `mcp-extension-result-${Date.now()}-${Math.random()}`;
  // Prefer filePath from tool args (agent targeting a specific file) over session state
  const activeFilePath = args?.filePath || currentDocState?.filePath;

  return new Promise((resolve) => {
    const TOOL_TIMEOUT_MS = 30000;
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(resultChannel);

      console.error(`[MCP Server] Extension tool timed out:`, {
        toolName,
        timeoutMs: TOOL_TIMEOUT_MS,
        activeFilePath,
      });

      const timeoutMessage = [
        `Extension Tool Timeout`,
        `  Tool: ${toolName}`,
        `  Timeout: ${TOOL_TIMEOUT_MS / 1000}s`,
        ``,
        `The tool did not respond in time. This could mean:`,
        `1. The tool is performing a long-running operation`,
        `2. The tool is stuck in an infinite loop`,
        `3. There was a silent error in the tool handler`,
        ``,
        `Check the extension logs for more details.`,
      ].join("\n");

      resolve({
        content: [{ type: "text", text: timeoutMessage }],
        isError: true,
      });
    }, TOOL_TIMEOUT_MS);

    ipcMain.once(resultChannel, (_event, result) => {
      clearTimeout(timeout);

      const hasExplicitSuccess = typeof result?.success === "boolean";
      const hasError = !!result?.error;
      const success = hasExplicitSuccess ? result.success : !hasError;

      // Extract enhanced error details if available
      const extensionId = result?.extensionId;
      const resultToolName = result?.toolName;
      const stack = result?.stack;
      const errorContext = result?.errorContext;

      let responseText: string;
      if (success) {
        if (result?.message) {
          responseText = result.message;
          if (result?.data) {
            responseText +=
              "\n\nData: " + JSON.stringify(result.data, null, 2);
          }
        } else {
          const dataToShow = { ...result };
          delete dataToShow.success;
          delete dataToShow.message;
          delete dataToShow.extensionId;
          delete dataToShow.toolName;
          delete dataToShow.stack;
          delete dataToShow.errorContext;
          responseText = JSON.stringify(dataToShow, null, 2);
        }
      } else {
        // Build detailed error message for Claude Code
        const errorParts: string[] = [];

        if (extensionId || resultToolName) {
          errorParts.push(`Extension Tool Error`);
          if (extensionId) errorParts.push(`  Extension: ${extensionId}`);
          if (resultToolName) errorParts.push(`  Tool: ${resultToolName}`);
          errorParts.push("");
        }

        errorParts.push(
          `Error: ${result?.error || result?.message || "Tool execution failed"}`
        );

        if (stack) {
          const truncatedStack = stack.split("\n").slice(0, 8).join("\n");
          errorParts.push("");
          errorParts.push("Stack trace:");
          errorParts.push(truncatedStack);
          if (stack.split("\n").length > 8) {
            errorParts.push("  ... (truncated)");
          }
        }

        if (errorContext && Object.keys(errorContext).length > 0) {
          errorParts.push("");
          errorParts.push("Context:");
          for (const [key, value] of Object.entries(errorContext)) {
            if (value !== undefined && value !== null) {
              const valueStr =
                typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value);
              errorParts.push(`  ${key}: ${valueStr}`);
            }
          }
        }

        responseText = errorParts.join("\n");
      }

      resolve({
        content: [{ type: "text", text: responseText }],
        isError: !success,
      });
    });

    // Send IPC to renderer to execute the tool.
    // Use the extension's original name (may contain dots) since the
    // renderer matches against the name defined in extension code.
    targetWindow.webContents.send("mcp:executeExtensionTool", {
      toolName: extensionTool.name,
      args: args || {},
      resultChannel,
      context: {
        workspacePath,
        activeFilePath,
      },
    });
  });
}
