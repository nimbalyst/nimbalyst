import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import {
  BUILT_IN_TOOLS,
  ToolRegistry,
  RuntimeToolExecutor,
} from '../tools';
import {
  setFileSystemService,
  clearFileSystemService,
  type FileSystemService
} from '../../core/FileSystemService';

describe('File Tools Integration with Tool Registry', () => {
  let toolRegistry: ToolRegistry;
  let toolExecutor: RuntimeToolExecutor;
  let mockFileSystemService: FileSystemService;

  // Test data
  const testFiles = [
    { path: 'src/index.ts', content: 'export const main = () => console.log("Hello");' },
    { path: 'src/utils/helpers.ts', content: 'export const formatDate = (date: Date) => date.toISOString();' },
    { path: 'test/index.test.ts', content: 'import { main } from "../src"; test("main", () => {});' },
    { path: 'README.md', content: '# Test Project\nThis is a test project.' },
  ];

  beforeAll(() => {
    // Setup mock file system
    mockFileSystemService = {
      getWorkspacePath: vi.fn(() => '/test/workspace'),

      searchFiles: vi.fn(async (query, options) => {
        const results = testFiles
          .filter(file => file.content.toLowerCase().includes(query.toLowerCase()))
          .map((file, index) => ({
            file: file.path,
            line: index + 1,
            content: file.content.split('\n')[0] || ''
          }));

        return {
          success: true,
          results: options?.maxResults ? results.slice(0, options.maxResults) : results,
          totalResults: results.length
        };
      }),

      listFiles: vi.fn(async (options) => {
        let files = testFiles.map(file => ({
          path: file.path,
          name: file.path.split('/').pop() || '',
          type: 'file' as const,
          size: file.content.length,
          modified: new Date().toISOString()
        }));

        if (options?.pattern) {
          // Simple pattern matching
          const pattern = options.pattern.replace('**/', '').replace('*', '.*');
          const regex = new RegExp(pattern);
          files = files.filter(f => regex.test(f.path));
        }

        return {
          success: true,
          files
        };
      }),

      readFile: vi.fn(async (path, options) => {
        const file = testFiles.find(f => f.path === path);
        if (!file) {
          return {
            success: false,
            error: `File not found: ${path}`
          };
        }

        return {
          success: true,
          content: file.content,
          size: file.content.length
        };
      })
    };

    // Set the mock file system service
    setFileSystemService(mockFileSystemService);
  });

  afterAll(() => {
    clearFileSystemService();
  });

  beforeEach(() => {
    // Initialize tool registry and executor
    toolRegistry = new ToolRegistry();
    toolExecutor = new RuntimeToolExecutor(toolRegistry);
    vi.clearAllMocks();
  });

  describe('Tool Registry Integration', () => {
    it('should have file tools registered in tool registry', () => {
      const tools = toolRegistry.getAll();
      const fileToolNames = ['searchFiles', 'listFiles', 'readFile'];

      for (const toolName of fileToolNames) {
        const tool = tools.find(t => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool?.description).toBeTruthy();
        expect(tool?.parameters).toBeDefined();
        expect(tool?.handler).toBeDefined();
        expect(tool?.source).toBe('runtime');
      }
    });

    it('should convert file tools to OpenAI format correctly', () => {
      const openAITools = toolRegistry.toOpenAI();

      const fileToolNames = ['searchFiles', 'listFiles', 'readFile'];
      for (const toolName of fileToolNames) {
        const openAITool = openAITools.find(t => t.function.name === toolName);
        expect(openAITool).toBeDefined();
        expect(openAITool?.type).toBe('function');
        expect(openAITool?.function.description).toBeTruthy();
        expect(openAITool?.function.parameters).toBeDefined();
      }
    });

    it('should convert file tools to Anthropic format correctly', () => {
      const anthropicTools = toolRegistry.toAnthropic();

      const fileToolNames = ['searchFiles', 'listFiles', 'readFile'];
      for (const toolName of fileToolNames) {
        const anthropicTool = anthropicTools.find(t => t.name === toolName);
        expect(anthropicTool).toBeDefined();
        expect(anthropicTool?.description).toBeTruthy();
        expect(anthropicTool?.input_schema).toBeDefined();
        expect(anthropicTool?.input_schema.type).toBe('object');
      }
    });
  });

  describe('Tool Execution', () => {
    it('should execute searchFiles tool with correct parameters', async () => {
      const tool = toolRegistry.get('searchFiles');
      expect(tool).toBeDefined();

      const result = await tool!.handler!({
        query: 'export',
        caseSensitive: false,
        maxResults: 10
      });

      expect(mockFileSystemService.searchFiles).toHaveBeenCalledWith('export', {
        caseSensitive: false,
        maxResults: 10
      });

      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('should execute listFiles tool with pattern filtering', async () => {
      const tool = toolRegistry.get('listFiles');
      expect(tool).toBeDefined();

      const result = await tool!.handler!({
        pattern: '**/*.test.ts',
        recursive: true
      });

      expect(mockFileSystemService.listFiles).toHaveBeenCalledWith({
        path: undefined,
        pattern: '**/*.test.ts',
        recursive: true,
        includeHidden: undefined,
        maxDepth: undefined
      });

      expect(result.success).toBe(true);
      expect(result.files).toBeDefined();
      expect(result.files.some((f: any) => f.path.includes('test'))).toBe(true);
    });

    it('should execute readFile tool and handle errors', async () => {
      const tool = toolRegistry.get('readFile');
      expect(tool).toBeDefined();

      // Successful read
      const successResult = await tool!.handler!({
        path: 'src/index.ts',
        encoding: 'utf-8'
      });

      expect(mockFileSystemService.readFile).toHaveBeenCalledWith('src/index.ts', {
        encoding: 'utf-8'
      });

      expect(successResult.success).toBe(true);
      expect(successResult.content).toContain('main');

      // Failed read
      const failResult = await tool!.handler!({
        path: 'non-existent.ts'
      });

      expect(failResult.success).toBe(false);
      expect(failResult.error).toContain('File not found');
    });

    it('should handle missing FileSystemService gracefully', async () => {
      // Temporarily clear the service
      clearFileSystemService();

      const tool = toolRegistry.get('searchFiles');
      const result = await tool!.handler!({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('File system service not available');

      // Restore service
      setFileSystemService(mockFileSystemService);
    });
  });

  describe('Tool Format Validation', () => {
    it('should have valid OpenAI tool format for searchFiles', () => {
      const openAITools = toolRegistry.toOpenAI();
      const searchTool = openAITools.find(t => t.function.name === 'searchFiles');

      expect(searchTool).toBeDefined();
      expect(searchTool?.function.parameters.type).toBe('object');
      expect(searchTool?.function.parameters.properties).toHaveProperty('query');
      expect(searchTool?.function.parameters.properties.query.type).toBe('string');
      expect(searchTool?.function.parameters.required).toContain('query');
    });

    it('should have valid Anthropic tool format for listFiles', () => {
      const anthropicTools = toolRegistry.toAnthropic();
      const listTool = anthropicTools.find(t => t.name === 'listFiles');

      expect(listTool).toBeDefined();
      expect(listTool?.input_schema.type).toBe('object');
      expect(listTool?.input_schema.properties).toHaveProperty('path');
      expect(listTool?.input_schema.properties).toHaveProperty('pattern');
      expect(listTool?.input_schema.required).toEqual([]);
    });

    it('should have valid tool format for readFile', () => {
      const tool = toolRegistry.get('readFile');

      expect(tool).toBeDefined();
      expect(tool?.parameters.type).toBe('object');
      expect(tool?.parameters.properties).toHaveProperty('path');
      expect(tool?.parameters.properties).toHaveProperty('encoding');
      expect(tool?.parameters.properties.encoding.enum).toContain('utf-8');
      expect(tool?.parameters.required).toContain('path');
    });
  });

  describe('Tool Registry Events', () => {
    it('should emit events when file tools are registered', () => {
      const newRegistry = new ToolRegistry([]);
      const onRegister = vi.fn();
      newRegistry.on('tool:registered', onRegister);

      // Register a file tool manually
      const searchTool = BUILT_IN_TOOLS.find(t => t.name === 'searchFiles');
      if (searchTool) {
        newRegistry.register(searchTool);
        expect(onRegister).toHaveBeenCalledWith(searchTool);
      }
    });
  });

  describe('Complex Tool Interactions', () => {
    it('should execute multiple file tools in sequence', async () => {
      const registry = toolRegistry;

      // 1. List all files
      const listTool = registry.get('listFiles');
      const listResult = await listTool!.handler!({});
      expect(listResult.success).toBe(true);
      expect(listResult.files.length).toBe(4);

      // 2. Search for specific content
      const searchTool = registry.get('searchFiles');
      const searchResult = await searchTool!.handler!({
        query: 'export',
        maxResults: 5
      });
      expect(searchResult.success).toBe(true);
      expect(searchResult.results.length).toBeGreaterThan(0);

      // 3. Read a specific file found in search
      const readTool = registry.get('readFile');
      const filePath = searchResult.results[0].file;
      const readResult = await readTool!.handler!({
        path: filePath
      });
      expect(readResult.success).toBe(true);
      expect(readResult.content).toBeTruthy();

      // Verify all tools were called
      expect(mockFileSystemService.listFiles).toHaveBeenCalled();
      expect(mockFileSystemService.searchFiles).toHaveBeenCalled();
      expect(mockFileSystemService.readFile).toHaveBeenCalled();
    });

    it('should handle workspace path in file operations', () => {
      const workspacePath = mockFileSystemService.getWorkspacePath();
      expect(workspacePath).toBe('/test/workspace');

      // Tools should work with relative paths within workspace
      const registry = toolRegistry;
      const tools = registry.getAll();
      const fileTools = tools.filter(t =>
        ['searchFiles', 'listFiles', 'readFile'].includes(t.name)
      );

      expect(fileTools).toHaveLength(3);
      fileTools.forEach(tool => {
        expect(tool.source).toBe('runtime');
      });
    });
  });
});