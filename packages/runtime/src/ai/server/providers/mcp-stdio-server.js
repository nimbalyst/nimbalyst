#!/usr/bin/env node
/**
 * Standalone MCP stdio server for Preditor
 * This can be spawned by Codex as an MCP server
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
// Debug logging to stderr (won't interfere with stdio protocol)
function debug(...args) {
    if (process.env.DEBUG_MCP_STDIO) {
        console.error('[MCP-STDIO]', ...args);
    }
}
debug('Starting Preditor MCP stdio server...');
// Define available tools
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
        name: 'list_files',
        description: 'List files in a directory',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'Directory path to list' }
            },
            required: ['dir']
        }
    },
    {
        name: 'search_files',
        description: 'Search for text in files',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'Directory to search in' },
                pattern: { type: 'string', description: 'Text pattern to search for' },
                extensions: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File extensions to search (e.g., [".js", ".ts"])'
                }
            },
            required: ['dir', 'pattern']
        }
    }
];
// Tool implementation
async function handleToolCall(name, args) {
    debug('Handling tool call:', name, args);
    try {
        switch (name) {
            case 'read_file': {
                if (!args.path)
                    throw new Error('path is required');
                const content = await fs.readFile(args.path, 'utf-8');
                return { content };
            }
            case 'write_file': {
                if (!args.path || args.content === undefined) {
                    throw new Error('path and content are required');
                }
                await fs.writeFile(args.path, args.content, 'utf-8');
                return { success: true, message: `File written: ${args.path}` };
            }
            case 'list_files': {
                if (!args.dir)
                    throw new Error('dir is required');
                const files = await fs.readdir(args.dir);
                const results = [];
                for (const file of files) {
                    const filePath = path.join(args.dir, file);
                    try {
                        const stats = await fs.stat(filePath);
                        results.push({
                            name: file,
                            path: filePath,
                            type: stats.isDirectory() ? 'directory' : 'file',
                            size: stats.size
                        });
                    }
                    catch (err) {
                        // Skip files we can't stat
                    }
                }
                return { files: results };
            }
            case 'search_files': {
                if (!args.dir || !args.pattern) {
                    throw new Error('dir and pattern are required');
                }
                // Simple grep-like implementation
                const results = [];
                const extensions = args.extensions || ['.js', '.ts', '.tsx', '.jsx', '.md', '.json'];
                async function searchDir(dir) {
                    const files = await fs.readdir(dir);
                    for (const file of files) {
                        const filePath = path.join(dir, file);
                        try {
                            const stats = await fs.stat(filePath);
                            if (stats.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
                                await searchDir(filePath);
                            }
                            else if (stats.isFile()) {
                                const ext = path.extname(file);
                                if (extensions.includes(ext)) {
                                    const content = await fs.readFile(filePath, 'utf-8');
                                    if (content.includes(args.pattern)) {
                                        const lines = content.split('\n');
                                        const matches = [];
                                        lines.forEach((line, index) => {
                                            if (line.includes(args.pattern)) {
                                                matches.push({
                                                    lineNumber: index + 1,
                                                    line: line.trim()
                                                });
                                            }
                                        });
                                        if (matches.length > 0) {
                                            results.push({
                                                file: filePath,
                                                matches: matches.slice(0, 5) // Limit to 5 matches per file
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        catch (err) {
                            // Skip files we can't read
                        }
                    }
                }
                await searchDir(args.dir);
                return { results, totalFiles: results.length };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        debug('Tool error:', error);
        return { error: error.message };
    }
}
// Start the MCP server
async function startServer() {
    const server = new Server({
        name: 'preditor-mcp',
        version: '1.0.0'
    }, {
        capabilities: {
            tools: {}
        }
    });
    // Register tool listing handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        debug('Listing tools');
        return { tools };
    });
    // Register tool call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        debug('Tool call request:', request.params.name);
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
        }
        catch (error) {
            debug('Tool call error:', error);
            throw new McpError(ErrorCode.InternalError, error.message);
        }
    });
    // Create stdio transport
    const transport = new StdioServerTransport();
    // Connect the server
    await server.connect(transport);
    debug('Server connected and ready');
    // Handle termination
    process.on('SIGINT', async () => {
        debug('Shutting down...');
        await server.close();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        debug('Shutting down...');
        await server.close();
        process.exit(0);
    });
}
// Start the server
startServer().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
