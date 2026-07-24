import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setFileSystemService,
  getFileSystemService,
  clearFileSystemService,
  type FileSystemService,
} from '../FileSystemService';

describe('FileSystemService Registry', () => {
  afterEach(() => {
    clearFileSystemService();
  });

  it('should set and get a file system service', () => {
    const mockService: FileSystemService = {
      getWorkspacePath: vi.fn(() => '/test/workspace'),
      searchFiles: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
    };

    setFileSystemService(mockService);
    const retrievedService = getFileSystemService();

    expect(retrievedService).toBe(mockService);
    expect(retrievedService?.getWorkspacePath()).toBe('/test/workspace');
  });

  it('should clear the file system service', () => {
    const mockService: FileSystemService = {
      getWorkspacePath: vi.fn(),
      searchFiles: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
    };

    setFileSystemService(mockService);
    expect(getFileSystemService()).toBe(mockService);

    clearFileSystemService();
    expect(getFileSystemService()).toBe(null);
  });

  it('should return null when no service is set', () => {
    expect(getFileSystemService()).toBe(null);
  });
});

describe('FileSystemService Mock Implementation', () => {
  let mockService: FileSystemService;

  beforeEach(() => {
    mockService = {
      getWorkspacePath: vi.fn(() => '/mock/workspace'),
      searchFiles: vi.fn(async (query, options) => ({
        success: true,
        results: [
          {
            file: 'test.ts',
            line: 10,
            content: `const test = "${query}";`,
          },
        ],
        totalResults: 1,
      })),
      listFiles: vi.fn(async (options) => ({
        success: true,
        files: [
          {
            path: 'src/index.ts',
            name: 'index.ts',
            type: 'file' as const,
            size: 1234,
            modified: '2024-01-01T00:00:00Z',
          },
          {
            path: 'src/components',
            name: 'components',
            type: 'directory' as const,
            size: 0,
            modified: '2024-01-01T00:00:00Z',
          },
        ],
      })),
      readFile: vi.fn(async (path, options) => ({
        success: true,
        content: `// File content for ${path}`,
        size: 100,
      })),
    };
  });

  it('should search files with query', async () => {
    const result = await mockService.searchFiles('test', {
      caseSensitive: false,
      maxResults: 10,
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0].file).toBe('test.ts');
    expect(result.results?.[0].content).toContain('test');
    expect(mockService.searchFiles).toHaveBeenCalledWith('test', {
      caseSensitive: false,
      maxResults: 10,
    });
  });

  it('should list files in workspace', async () => {
    const result = await mockService.listFiles({
      recursive: false,
      includeHidden: false,
    });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files?.[0].type).toBe('file');
    expect(result.files?.[1].type).toBe('directory');
  });

  it('should read file content', async () => {
    const result = await mockService.readFile('src/index.ts', {
      encoding: 'utf-8',
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('File content for src/index.ts');
    expect(result.size).toBe(100);
    expect(mockService.readFile).toHaveBeenCalledWith('src/index.ts', {
      encoding: 'utf-8',
    });
  });

  it('should handle search errors', async () => {
    mockService.searchFiles = vi.fn(async () => ({
      success: false,
      error: 'Search failed',
    }));

    const result = await mockService.searchFiles('test', {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('Search failed');
  });

  it('should handle list errors', async () => {
    mockService.listFiles = vi.fn(async () => ({
      success: false,
      error: 'Permission denied',
    }));

    const result = await mockService.listFiles({});
    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });

  it('should handle read errors', async () => {
    mockService.readFile = vi.fn(async () => ({
      success: false,
      error: 'File not found',
    }));

    const result = await mockService.readFile('missing.txt', {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('File not found');
  });
});