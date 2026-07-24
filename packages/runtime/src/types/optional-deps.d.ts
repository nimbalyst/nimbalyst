// Type declarations for optional dependencies that are dynamically loaded

declare module '@anthropic-ai/claude-agent-sdk' {
  export interface Query extends AsyncGenerator<any, void> {
    interrupt(): Promise<void>;
    setPermissionMode(mode: any): Promise<void>;
    setModel(model?: string): Promise<void>;
    setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
    initializationResult(): Promise<any>;
    supportedCommands(): Promise<any[]>;
    supportedModels(): Promise<any[]>;
    mcpServerStatus(): Promise<any[]>;
    accountInfo(): Promise<any>;
    rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<any>;
    reconnectMcpServer(serverName: string): Promise<void>;
    toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
    setMcpServers(servers: Record<string, any>): Promise<any>;
    streamInput(stream: AsyncIterable<any>): Promise<void>;
    close(): void;
  }
  export function query(params: { prompt: string | AsyncIterable<any>; options?: any }): Query;
  export function tool(name: string, description: string, inputSchema: any, handler: any): any;
  export function createSdkMcpServer(options: any): any;
  export class AbortError extends Error {}
  export type Options = any;
  export type SDKMessage = any;
  export type SDKUserMessage = any;
  export type SDKAssistantMessage = any;
  export type McpServerConfig = any;
  export type McpSdkServerConfigWithInstance = any;
  export type SlashCommand = any;
  export type ModelInfo = any;
  export type AccountInfo = any;
  export type AgentDefinition = any;
}

declare module '@modelcontextprotocol/sdk/server/index.js' {
  export class Server {
    constructor(info: any, options?: any);
    setRequestHandler(schema: any, handler: any): void;
    connect(transport: any): Promise<void>;
    close(): Promise<void>;
    sendToolListChanged(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
  }
}

declare module '@modelcontextprotocol/sdk/types.js' {
  export const CallToolRequestSchema: any;
  export const ListToolsRequestSchema: any;
  export const ErrorCode: {
    InternalError: number;
    InvalidRequest: number;
    MethodNotFound: number;
    InvalidParams: number;
    [key: string]: number;
  };
  export class McpError extends Error {
    constructor(code: number, message: string);
  }
  export type Tool = any;
}

declare module 'gifuct-js' {
  export function parseGIF(data: ArrayBuffer): any;
  export function decompressFrames(gif: any, buildImagePatches?: boolean): any[];
}

declare module '@openai/codex-sdk' {
  export class Codex {
    constructor(options?: Record<string, unknown>);
    startThread(options?: Record<string, unknown>): any;
    resumeThread(threadId: string): any;
  }
}
