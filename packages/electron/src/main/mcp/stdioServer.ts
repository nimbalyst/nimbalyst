/**
 * MCP stdio server that can be spawned as a subprocess
 * This allows tools like Codex to use our MCP server via stdio
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { BrowserWindow } from 'electron';

// Store document state
let documentState: any = null;

// Tool handlers - we'll need to import these from the main process
const tools = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'append_to_document',
    description: 'Append text to the current document',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to append' }
      },
      required: ['text']
    }
  },
  {
    name: 'replace_in_document',
    description: 'Replace text in the current document',
    inputSchema: {
      type: 'object',
      properties: {
        searchText: { type: 'string', description: 'Text to search for' },
        replaceText: { type: 'string', description: 'Text to replace with' }
      },
      required: ['searchText', 'replaceText']
    }
  }
];

async function handleToolCall(name: string, args: any) {
  // Simple implementations for now
  switch (name) {
    case 'read_file':
      const fs = require('fs').promises;
      try {
        const content = await fs.readFile(args.path, 'utf-8');
        return { content };
      } catch (error: any) {
        return { error: error.message };
      }

    case 'write_file':
      const fs2 = require('fs').promises;
      try {
        await fs2.writeFile(args.path, args.content, 'utf-8');
        return { success: true };
      } catch (error: any) {
        return { error: error.message };
      }

    case 'append_to_document':
      if (!documentState) {
        return { error: 'No document is open' };
      }
      // In a real implementation, this would communicate with the renderer
      return { success: true, message: 'Would append text to document' };

    case 'replace_in_document':
      if (!documentState) {
        return { error: 'No document is open' };
      }
      // In a real implementation, this would communicate with the renderer
      return { success: true, message: 'Would replace text in document' };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function startStdioMcpServer() {
  console.error('[MCP stdio] Starting MCP stdio server...');

  const server = new Server(
    {
      name: 'nimbalyst-stdio',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.onerror = (error) => {
    console.error("[MCP:nimbalyst-stdio] Server error:", error);
  };

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error('[MCP stdio] Listing tools');
    return { tools };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    console.error('[MCP stdio] Tool call:', request.params.name);

    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error('[MCP stdio] Tool error:', error);
      throw new McpError(ErrorCode.InternalError, error.message);
    }
  });

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect the server to the transport
  await server.connect(transport);

  console.error('[MCP stdio] Server started and listening on stdio');

  // Handle process termination
  process.on('SIGINT', async () => {
    console.error('[MCP stdio] Shutting down...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[MCP stdio] Shutting down...');
    await server.close();
    process.exit(0);
  });
}

// If this file is run directly, start the server
if (require.main === module) {
  startStdioMcpServer().catch(error => {
    console.error('[MCP stdio] Fatal error:', error);
    process.exit(1);
  });
}