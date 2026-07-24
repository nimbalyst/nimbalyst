import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

// Mock all dependencies before imports
const { mockExecAsync } = vi.hoisted(() => ({ mockExecAsync: vi.fn() }));
vi.mock('child_process');
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: vi.fn(() => mockExecAsync),
  };
});
vi.mock('fs/promises');
vi.mock('glob');
vi.mock('../utils/logger', () => ({
  logger: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Import modules after mocks
import { ElectronFileSystemService } from '../ElectronFileSystemService';
import * as fs from 'fs/promises';
import { glob } from 'glob';

describe('ElectronFileSystemService', () => {
  let service: ElectronFileSystemService;
  const testWorkspacePath = '/test/workspace';

  beforeEach(() => {
    // Clear mocks before creating service
    vi.clearAllMocks();

    service = new ElectronFileSystemService(testWorkspacePath);
  });

  afterEach(() => {
    service.destroy();
  });

  describe('getWorkspacePath', () => {
    it('should return the workspace path', () => {
      expect(service.getWorkspacePath()).toBe(testWorkspacePath);
    });
  });

  describe('searchFiles', () => {
    it('should search files using ripgrep', async () => {
      const mockOutput = JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/test/workspace/src/index.ts' },
          line_number: 10,
          lines: { text: '  const result = "test";\n' },
        },
      }) + '\n' + JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/test/workspace/src/utils.ts' },
          line_number: 20,
          lines: { text: '  return test();\n' },
        },
      });

      mockExecAsync.mockResolvedValue({ stdout: mockOutput });

      const result = await service.searchFiles('test', {
        caseSensitive: false,
        maxResults: 50,
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results?.[0]).toEqual({
        file: 'src/index.ts',
        line: 10,
        content: 'const result = "test";',
      });
      expect(result.results?.[1]).toEqual({
        file: 'src/utils.ts',
        line: 20,
        content: 'return test();',
      });
      expect(result.totalResults).toBe(2);
    });

    it('should handle search with file pattern', async () => {
      mockExecAsync.mockResolvedValue({ stdout: '' });

      await service.searchFiles('test', {
        path: 'src',
        filePattern: '*.ts',
        caseSensitive: true,
        maxResults: 10,
      });

      expect(mockExecAsync).toHaveBeenCalledWith(
        'rg',
        expect.arrayContaining(['-g', '*.ts']),
        expect.any(Object),
      );
    });

    it('should handle search errors', async () => {
      mockExecAsync.mockRejectedValue(new Error('Command failed'));

      const result = await service.searchFiles('test', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Command failed');
    });
  });

  describe('listFiles', () => {
    it('should list files in directory', async () => {
      const mockFiles = [
        { name: 'index.ts', isDirectory: () => false },
        { name: 'utils', isDirectory: () => true },
        { name: '.hidden', isDirectory: () => false },
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);
      (fs.stat as Mock).mockResolvedValue({
        size: 1000,
        mtime: new Date('2024-01-01'),
        isDirectory: () => false,
      });

      const result = await service.listFiles({ includeHidden: false });

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(2); // Hidden file excluded
      expect(result.files?.[0].name).toBe('utils'); // Directory first
      expect(result.files?.[0].type).toBe('directory');
      expect(result.files?.[1].name).toBe('index.ts');
      expect(result.files?.[1].type).toBe('file');
    });

    it('should list files with pattern using glob', async () => {
      vi.mocked(glob).mockResolvedValue([
        '/test/workspace/src/index.ts',
        '/test/workspace/src/components/Button.tsx',
      ] as any);

      (fs.stat as Mock).mockResolvedValue({
        size: 500,
        mtime: new Date('2024-01-01'),
        isDirectory: () => false,
      });

      const result = await service.listFiles({
        pattern: '**/*.{ts,tsx}',
        recursive: true,
      });

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(2);
      expect(result.files?.[0].path).toBe('src/index.ts');
      expect(result.files?.[1].path).toBe('src/components/Button.tsx');
    });

    it('should handle list errors', async () => {
      (fs.readdir as Mock).mockRejectedValue(new Error('Permission denied'));

      const result = await service.listFiles({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should exclude common directories', async () => {
      const mockFiles = [
        { name: 'src', isDirectory: () => true },
        { name: 'node_modules', isDirectory: () => true },
        { name: '.git', isDirectory: () => true },
        { name: 'dist', isDirectory: () => true },
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);
      (fs.stat as Mock).mockResolvedValue({
        size: 0,
        mtime: new Date(),
        isDirectory: () => true,
      });

      const result = await service.listFiles({});

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files?.[0].name).toBe('src');
    });
  });

  describe('readFile', () => {
    it('should read file content', async () => {
      const mockContent = 'export const test = "Hello World";';
      (fs.readFile as Mock).mockResolvedValue(mockContent);

      const result = await service.readFile('src/index.ts', {
        encoding: 'utf-8',
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe(mockContent);
      expect(result.size).toBe(mockContent.length);
      expect(result.truncated).toBeUndefined();
    });

    it('should reject absolute paths', async () => {
      const result = await service.readFile('/etc/passwd', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path contains dangerous patterns');
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('should prevent path traversal', async () => {
      const result = await service.readFile('../../../etc/passwd', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path contains dangerous patterns');
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('should exclude binary files', async () => {
      const result = await service.readFile('archive.zip', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('File type is not supported for reading');
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('should truncate large files', async () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB
      (fs.readFile as Mock).mockResolvedValue(largeContent);

      const result = await service.readFile('large.txt', {});

      expect(result.success).toBe(true);
      expect(result.content?.length).toBe(1024 * 1024); // Truncated to 1MB
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(2 * 1024 * 1024);
    });

    it('should handle read errors', async () => {
      (fs.readFile as Mock).mockRejectedValue(new Error('File not found'));

      const result = await service.readFile('missing.txt', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found');
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      // Currently no resources to clean up, but test the method exists
      expect(() => service.destroy()).not.toThrow();
    });
  });
});
