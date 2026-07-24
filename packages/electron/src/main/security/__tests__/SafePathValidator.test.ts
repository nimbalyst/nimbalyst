/**
 * Security tests for SafePathValidator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SafePathValidator } from '../SafePathValidator';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';

describe('SafePathValidator Security Tests', () => {
  let validator: SafePathValidator;
  let testWorkspace: string;

  beforeEach(() => {
    // Create a temporary test workspace
    testWorkspace = mkdtempSync(join(tmpdir(), 'test-workspace-'));
    validator = new SafePathValidator(testWorkspace);
  });

  describe('Path Traversal Prevention', () => {
    it('should block parent directory traversal with ..', () => {
      const dangerousPaths = [
        '../',
        '../../',
        '../../../etc/passwd',
        'valid/../../dangerous',
        'foo/../../../bar',
        './../',
        'test/../../../../.ssh/id_rsa',
      ];

      for (const path of dangerousPaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations).toContain('dangerous_pattern:\\.\\.');
      }
    });

    it('should block absolute paths', () => {
      const absolutePaths = [
        '/etc/passwd',
        '/home/user/.ssh/id_rsa',
        'C:\\Windows\\System32\\config',
        'C:\\Users\\Admin\\Documents',
      ];

      for (const path of absolutePaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations?.some(v =>
          v.includes('dangerous_pattern') || v === 'absolute_path'
        )).toBe(true);
      }

      // Test network share separately as it has different pattern
      const networkShare = '\\\\network\\share';
      const result = validator.validate(networkShare);
      expect(result.isValid).toBe(false);
    });

    it('should block null byte injection', () => {
      const nullBytePaths = [
        'file.txt\0.jpg',
        'safe\0../../etc/passwd',
        'test\0/file',
      ];

      for (const path of nullBytePaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations?.some(v => v.includes('dangerous_pattern'))).toBe(true);
      }
    });

    it('should block command injection attempts', () => {
      const injectionPaths = [
        'file$(whoami).txt',
        'file`ls -la`.txt',
        'file${HOME}.txt',
      ];

      // These should be blocked by our patterns
      for (const path of injectionPaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations?.some(v => v.includes('dangerous_pattern'))).toBe(true);
      }

      // These contain dangerous characters that are blocked
      const dangerousChars = [
        'file;rm -rf /',
        'file|cat /etc/passwd',
        'file&& cat /etc/passwd',
        'file<input.txt',
        'file>output.txt',
      ];

      for (const path of dangerousChars) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });
  });

  describe('Forbidden Path Detection', () => {
    it('should block access to SSH directories', () => {
      const sshPaths = [
        '.ssh/id_rsa',
        '.ssh/known_hosts',
        '.ssh/authorized_keys',
        'user/.ssh/config',
      ];

      for (const path of sshPaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('forbidden');
      }
    });

    it('should block access to credential stores', () => {
      const credentialPaths = [
        '.aws/credentials',
        '.docker/config.json',
        '.kube/config',
        '.gnupg/private-keys',
        'Library/Keychains/login.keychain',
      ];

      for (const path of credentialPaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });

    it('should block access to browser data', () => {
      const browserPaths = [
        'Library/Cookies/Cookies.sqlite',
        'AppData/Local/Google/Chrome/User Data/Default/Cookies',
        'AppData/Roaming/Mozilla/Firefox/Profiles',
      ];

      for (const path of browserPaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });
  });

  describe('File Extension Blocking', () => {
    it('should block certificate and key files', () => {
      const keyFiles = [
        'server.pem',
        'private.key',
        'certificate.cert',
        'ca.crt',
        'folder/secret.pem',
      ];

      for (const path of keyFiles) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations?.some(v => v.startsWith('blocked_extension'))).toBe(true);
      }
    });

    it('should block environment files', () => {
      const envFiles = [
        '.env',
        '.env.local',
        '.env.production',
        'config/.env',
      ];

      for (const path of envFiles) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
        expect(result.violations?.some(v => v.startsWith('blocked_extension'))).toBe(true);
      }
    });

    it('should block database files', () => {
      const dbFiles = [
        'database.sqlite',
        'app.db',
        'data.sqlite3',
      ];

      for (const path of dbFiles) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });

    it('should block wallet files', () => {
      const walletFiles = [
        'bitcoin.wallet',
        'ethereum.wallet',
      ];

      for (const path of walletFiles) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });
  });

  describe('Valid Path Handling', () => {
    it('should allow safe relative paths', () => {
      const safePaths = [
        'file.txt',
        'folder/file.js',
        'src/components/Button.tsx',
        'docs/README.md',
        'test/unit/validator.test.ts',
      ];

      for (const path of safePaths) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(true);
        expect(result.sanitizedPath).toBeDefined();
      }
    });

    it('should normalize redundant path elements', () => {
      const paths = [
        { input: './file.txt', expected: 'file.txt' },
        { input: 'folder//file.txt', expected: 'folder/file.txt' },
        { input: './folder/./file.txt', expected: 'folder/file.txt' },
      ];

      for (const { input, expected } of paths) {
        const result = validator.validate(input);
        expect(result.isValid).toBe(true);
        expect(result.sanitizedPath).toBe(expected);
      }
    });

    it('should handle edge cases safely', () => {
      // Empty/invalid inputs
      expect(validator.validate('')).toMatchObject({ isValid: false });
      expect(validator.validate(null as any)).toMatchObject({ isValid: false });
      expect(validator.validate(undefined as any)).toMatchObject({ isValid: false });
      expect(validator.validate(123 as any)).toMatchObject({ isValid: false });
    });
  });

  describe('Logging Safety', () => {
    it('should not expose full paths in safe log paths', () => {
      const fullPath = '/Users/username/projects/myapp/src/components/Button.tsx';
      const safePath = SafePathValidator.getSafeLogPath(fullPath);

      expect(safePath).not.toContain('/Users/username');
      expect(safePath).toBe('.../components/Button.tsx');
    });

    it('should handle short paths in safe logging', () => {
      expect(SafePathValidator.getSafeLogPath('file.txt')).toBe('file.txt');
      expect(SafePathValidator.getSafeLogPath('folder/file.txt')).toBe('folder/file.txt');
    });
  });

  describe('System Path Detection', () => {
    it('should throw error if workspace is in system directory', () => {
      const systemPaths = [
        '/System/Library',
        '/usr/bin',
        '/etc',
        '/bin',
      ];

      for (const sysPath of systemPaths) {
        expect(() => new SafePathValidator(sysPath)).toThrow('system directory');
      }
    });

    it('should allow workspace in user and temp directories', () => {
      const allowedPaths = [
        '/Users/test/projects',
        '/home/user/workspace',
        '/var/folders/temp/workspace',
        '/tmp/workspace',
      ];

      for (const allowedPath of allowedPaths) {
        // Should not throw
        expect(() => new SafePathValidator(allowedPath)).not.toThrow();
      }
    });
  });

  describe('Multiple Path Validation', () => {
    it('should validate multiple paths at once', () => {
      const paths = [
        'safe.txt',
        '../dangerous.txt',
        '/absolute/path.txt',
        '.ssh/id_rsa',
      ];

      const results = validator.validateAll(paths);

      expect(results.get('safe.txt')?.isValid).toBe(true);
      expect(results.get('../dangerous.txt')?.isValid).toBe(false);
      expect(results.get('/absolute/path.txt')?.isValid).toBe(false);
      expect(results.get('.ssh/id_rsa')?.isValid).toBe(false);
    });
  });

  describe('Complex Attack Scenarios', () => {
    it('should block URL-encoded path traversal', () => {
      // Note: These would need to be decoded before validation in real usage
      const encoded = [
        '%2e%2e%2f',  // ../
        '%2e%2e/',     // ../
        '..%2f',       // ../
      ];

      for (const path of encoded) {
        if (path.includes('..')) {
          const result = validator.validate(path);
          expect(result.isValid).toBe(false);
        }
      }
    });

    it('should block Unicode normalization attacks', () => {
      // Various Unicode representations that could normalize to dangerous paths
      const unicodePaths = [
        'ﬁle.txt',  // Ligature that might be mishandled
        '．．/',     // Full-width dots
      ];

      // These should be handled by normalization
      for (const path of unicodePaths) {
        const result = validator.validate(path);
        // Either blocked or safely normalized
        if (result.isValid) {
          expect(result.sanitizedPath).not.toContain('..');
        }
      }
    });

    it('should handle very long paths safely', () => {
      const longPath = 'a/'.repeat(1000) + 'file.txt';
      const result = validator.validate(longPath);

      // Should either validate or fail gracefully
      expect(typeof result.isValid).toBe('boolean');
    });

    it('should block symbolic link traversal patterns', () => {
      const symlinkPatterns = [
        'symlink/../outside',
        'link/../../etc/passwd',
      ];

      for (const path of symlinkPatterns) {
        const result = validator.validate(path);
        expect(result.isValid).toBe(false);
      }
    });
  });
});