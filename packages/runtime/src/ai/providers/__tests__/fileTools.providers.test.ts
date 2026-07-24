/**
 * Integration tests for file tools with actual AI providers.
 * These tests only run when API keys are configured in environment variables.
 *
 * To run these tests:
 * 1. Set up your .env file with:
 *    - OPENAI_API_KEY=your-key
 *    - ANTHROPIC_API_KEY=your-key
 * 2. Run: RUN_AI_PROVIDER_TESTS=true npm test
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ProviderFactory } from '../../server/ProviderFactory';
import { ToolRegistry } from '../../tools';
import {
  setFileSystemService,
  clearFileSystemService,
  type FileSystemService
} from '../../../core/FileSystemService';

describe.skipIf(typeof window !== 'undefined')('File Tools with Real AI Providers', () => {
  const runProviderTests = process.env.RUN_AI_PROVIDER_TESTS === 'true';
  const openAIKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let mockFileSystemService: FileSystemService;

  beforeAll(() => {
    // Setup mock file system with realistic data
    mockFileSystemService = {
      getWorkspacePath: vi.fn(() => '/workspace/my-project'),

      searchFiles: vi.fn(async (query) => ({
        success: true,
        results: [
          {
            file: 'src/components/Button.tsx',
            line: 5,
            content: `export const Button: React.FC<ButtonProps> = ({ onClick, children }) => {`
          },
          {
            file: 'src/utils/api.ts',
            line: 12,
            content: `export async function fetchUser(id: string): Promise<User> {`
          },
          {
            file: 'src/hooks/useAuth.ts',
            line: 8,
            content: `export function useAuth() {`
          }
        ],
        totalResults: 3
      })),

      listFiles: vi.fn(async () => ({
        success: true,
        files: [
          {
            path: 'src/index.tsx',
            name: 'index.tsx',
            type: 'file' as const,
            size: 2456,
            modified: '2024-01-15T10:30:00Z'
          },
          {
            path: 'src/components',
            name: 'components',
            type: 'directory' as const,
            size: 0,
            modified: '2024-01-14T09:00:00Z'
          },
          {
            path: 'package.json',
            name: 'package.json',
            type: 'file' as const,
            size: 1024,
            modified: '2024-01-10T08:00:00Z'
          }
        ]
      })),

      readFile: vi.fn(async (path) => {
        const files: Record<string, string> = {
          'package.json': JSON.stringify({
            name: 'my-project',
            version: '1.0.0',
            dependencies: {
              react: '^18.2.0',
              typescript: '^5.0.0'
            }
          }, null, 2),
          'src/index.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);`
        };

        const content = files[path];
        if (!content) {
          return {
            success: false,
            error: `File not found: ${path}`
          };
        }

        return {
          success: true,
          content,
          size: content.length
        };
      })
    };

    setFileSystemService(mockFileSystemService);
  });

  afterEach(() => {
    ProviderFactory.destroyAll();
  });

  afterAll(() => {
    clearFileSystemService();
  });

  it.skipIf(!runProviderTests || !openAIKey)('should use file tools through OpenAI function calling', async () => {
    const provider = ProviderFactory.createProvider('openai', 'test-file-tools-openai');
    await provider.initialize({
      apiKey: openAIKey!,
      model: 'gpt-4o-mini',
      maxTokens: 500
    });

    // Register tool handlers to capture tool calls
    const toolCalls: any[] = [];
    provider.registerToolHandler({
      searchFiles: async (args: any) => {
        toolCalls.push({ tool: 'searchFiles', args });
        const result = await mockFileSystemService.searchFiles(args.query, args);
        console.log('searchFiles result:', result);
        return result;
      },
      listFiles: async (args: any) => {
        toolCalls.push({ tool: 'listFiles', args });
        const result = await mockFileSystemService.listFiles(args);
        console.log('listFiles result:', result);
        return result;
      },
      readFile: async (args: any) => {
        toolCalls.push({ tool: 'readFile', args });
        const result = await mockFileSystemService.readFile(args.path, args);
        console.log('readFile result:', result);
        return result;
      }
    });

    // Send a message that should trigger file tool usage
    // The sendMessage method returns an async iterator for streaming
    const stream = provider.sendMessage(
      'List the files in this project and tell me what dependencies it uses. Use the listFiles and readFile tools.',
      {
        filePath: '/workspace/test.md',
        fileType: 'markdown',
        content: 'Test document',
        cursorPosition: { line: 0, column: 0 }
      },
      'test-session'
    );

    // Collect the streaming response
    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content;
      }
    }

    console.log('Response:', fullResponse);
    console.log('Tool calls made:', toolCalls);

    // Verify tools were called
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls.some(call => call.tool === 'listFiles' || call.tool === 'readFile')).toBe(true);

    // Response should mention the project structure or dependencies
    expect(fullResponse.toLowerCase()).toMatch(/react|typescript|package|dependencies|files?/);
  }, 30000); // Increase timeout for API calls

  it.skipIf(!runProviderTests || !anthropicKey)('should use file tools through Claude tool use', async () => {
    const provider = ProviderFactory.createProvider('claude', 'test-file-tools-claude');
    await provider.initialize({
      apiKey: anthropicKey!,
      model: 'claude-3-5-haiku-latest',
      maxTokens: 500
    });

    // Register tool handlers
    const toolCalls: any[] = [];
    provider.registerToolHandler({
      searchFiles: async (args: any) => {
        toolCalls.push({ tool: 'searchFiles', args });
        const result = await mockFileSystemService.searchFiles(args.query, args);
        console.log('searchFiles result:', result);
        return result;
      },
      listFiles: async (args: any) => {
        toolCalls.push({ tool: 'listFiles', args });
        const result = await mockFileSystemService.listFiles(args);
        console.log('listFiles result:', result);
        return result;
      },
      readFile: async (args: any) => {
        toolCalls.push({ tool: 'readFile', args });
        const result = await mockFileSystemService.readFile(args.path, args);
        console.log('readFile result:', result);
        return result;
      }
    });

    // Send a message that requires file exploration
    // The sendMessage method returns an async iterator for streaming
    const stream = provider.sendMessage(
      'Search for React components in this project using the searchFiles tool and list them',
      {
        filePath: '/workspace/test.md',
        fileType: 'markdown',
        content: 'Test document',
        cursorPosition: { line: 0, column: 0 }
      },
      'test-session'
    );

    // Collect the streaming response
    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content;
      }
    }

    console.log('Response:', fullResponse);
    console.log('Tool calls made:', toolCalls);

    // Verify tools were called
    expect(toolCalls.length).toBeGreaterThan(0);

    // Response should mention React components
    expect(fullResponse.toLowerCase()).toMatch(/button|component|react|search/);
  }, 30000);

  it('should validate file tool registration in tool registry', () => {
    // This test verifies that file tools are properly registered in the global tool registry
    // The provider uses a central ToolRegistry that contains all built-in tools

    // Create a new tool registry instance
    const registry = new ToolRegistry();

    // Get all registered tools
    const tools = registry.getAll();
    const fileToolNames = tools.map(t => t.name);

    // Check that file tools are included
    expect(fileToolNames).toContain('searchFiles');
    expect(fileToolNames).toContain('listFiles');
    expect(fileToolNames).toContain('readFile');

    // Also verify that these tools can be converted to provider formats
    const openAITools = registry.toOpenAI();
    const anthropicTools = registry.toAnthropic();

    // Check OpenAI format
    const openAIFileTools = openAITools.filter(t =>
      ['searchFiles', 'listFiles', 'readFile'].includes(t.function.name)
    );
    expect(openAIFileTools).toHaveLength(3);

    // Check Anthropic format
    const anthropicFileTools = anthropicTools.filter(t =>
      ['searchFiles', 'listFiles', 'readFile'].includes(t.name)
    );
    expect(anthropicFileTools).toHaveLength(3);
  });
});
