import { describe, it, expect } from 'vitest';
import { toProjectRelative, shortenPath, formatToolArguments } from '../pathResolver';

describe('pathResolver', () => {
  describe('toProjectRelative', () => {
    it('should convert absolute path to project-relative', () => {
      const workspacePath = '/Users/john/projects/myapp';
      const absolutePath = '/Users/john/projects/myapp/src/index.ts';
      expect(toProjectRelative(absolutePath, workspacePath)).toBe('src/index.ts');
    });

    it('should handle paths with trailing slashes', () => {
      const workspacePath = '/Users/john/projects/myapp/';
      const absolutePath = '/Users/john/projects/myapp/src/index.ts';
      expect(toProjectRelative(absolutePath, workspacePath)).toBe('src/index.ts');
    });

    it('should return original path if outside workspace', () => {
      const workspacePath = '/Users/john/projects/myapp';
      const absolutePath = '/Users/john/other/file.ts';
      expect(toProjectRelative(absolutePath, workspacePath)).toBe('/Users/john/other/file.ts');
    });

    it('should return original path if no workspace provided', () => {
      const absolutePath = '/Users/john/projects/myapp/src/index.ts';
      expect(toProjectRelative(absolutePath)).toBe('/Users/john/projects/myapp/src/index.ts');
    });

    it('should return "." for workspace root', () => {
      const workspacePath = '/Users/john/projects/myapp';
      const absolutePath = '/Users/john/projects/myapp';
      expect(toProjectRelative(absolutePath, workspacePath)).toBe('.');
    });
  });

  describe('shortenPath', () => {
    it('should not shorten paths shorter than maxLength', () => {
      expect(shortenPath('src/index.ts', 60)).toBe('src/index.ts');
    });

    it('should preserve filename when shortening', () => {
      const path = 'packages/electron/src/renderer/components/AgentTranscript/RichTranscriptView.tsx';
      const shortened = shortenPath(path, 50);
      expect(shortened).toContain('RichTranscriptView.tsx');
      expect(shortened.length).toBeLessThanOrEqual(60); // Some tolerance
    });

    it('should show first and last directory when possible', () => {
      const path = 'packages/electron/src/renderer/components/RichTranscriptView.tsx';
      const shortened = shortenPath(path, 50);
      expect(shortened).toContain('packages/');
      expect(shortened).toContain('RichTranscriptView.tsx');
      expect(shortened).toContain('...');
    });

    it('should handle paths with no directory separator', () => {
      expect(shortenPath('verylongfilename.txt', 10)).toBe('verylon...');
    });

    it('should always preserve filename even if it exceeds maxLength', () => {
      const path = 'src/VeryLongComponentNameThatExceedsMaxLength.tsx';
      const shortened = shortenPath(path, 20);
      expect(shortened).toContain('VeryLongComponentNameThatExceedsMaxLength.tsx');
      expect(shortened).toContain('.../');
    });
  });

  describe('formatToolArguments', () => {
    const workspacePath = '/Users/john/projects/myapp';

    describe('Read tool', () => {
      it('should format file path', () => {
        const args = { file_path: '/Users/john/projects/myapp/src/index.ts' };
        const result = formatToolArguments('Read', args, workspacePath);
        expect(result).toBe('src/index.ts');
      });

      it('should include line range', () => {
        const args = {
          file_path: '/Users/john/projects/myapp/src/index.ts',
          offset: 10,
          limit: 50
        };
        const result = formatToolArguments('Read', args, workspacePath);
        expect(result).toContain('src/index.ts');
        expect(result).toContain('lines 10-60');
      });

      it('should handle offset only', () => {
        const args = {
          file_path: '/Users/john/projects/myapp/src/index.ts',
          offset: 100
        };
        const result = formatToolArguments('Read', args, workspacePath);
        expect(result).toContain('from line 100');
      });

      it('should handle limit only', () => {
        const args = {
          file_path: '/Users/john/projects/myapp/src/index.ts',
          limit: 50
        };
        const result = formatToolArguments('Read', args, workspacePath);
        expect(result).toContain('first 50 lines');
      });
    });

    describe('Edit tool', () => {
      it('should format file path', () => {
        const args = { file_path: '/Users/john/projects/myapp/src/component.tsx' };
        const result = formatToolArguments('Edit', args, workspacePath);
        expect(result).toBe('src/component.tsx');
      });
    });

    describe('Write tool', () => {
      it('should format file path', () => {
        const args = { file_path: '/Users/john/projects/myapp/src/new.tsx' };
        const result = formatToolArguments('Write', args, workspacePath);
        expect(result).toBe('src/new.tsx');
      });
    });

    describe('Glob tool', () => {
      it('should format pattern', () => {
        const args = { pattern: '**/*.tsx' };
        const result = formatToolArguments('Glob', args, workspacePath);
        expect(result).toBe('**/*.tsx');
      });

      it('should format path if no pattern', () => {
        const args = { path: '/Users/john/projects/myapp/src' };
        const result = formatToolArguments('Glob', args, workspacePath);
        expect(result).toBe('src');
      });
    });

    describe('Grep tool', () => {
      it('should format pattern and path', () => {
        const args = {
          pattern: 'loadSessions',
          path: '/Users/john/projects/myapp/src'
        };
        const result = formatToolArguments('Grep', args, workspacePath);
        expect(result).toBe('"loadSessions" in src');
      });

      it('should truncate long patterns', () => {
        const args = {
          pattern: 'very'.repeat(20),
          path: '/Users/john/projects/myapp/src'
        };
        const result = formatToolArguments('Grep', args, workspacePath);
        expect(result).toContain('...');
        expect(result).toContain('in src');
      });
    });

    describe('Bash tool', () => {
      it('should format command', () => {
        const args = { command: 'git log --oneline -10' };
        const result = formatToolArguments('Bash', args, workspacePath);
        expect(result).toBe('git log --oneline -10');
      });

      it('should truncate long commands', () => {
        const args = { command: 'very long command '.repeat(10) };
        const result = formatToolArguments('Bash', args, workspacePath);
        expect(result).toContain('...');
        expect(result.length).toBeLessThanOrEqual(53);
      });
    });

    describe('Unknown tools', () => {
      it('should try to extract file path from common properties', () => {
        const args = { filePath: '/Users/john/projects/myapp/src/test.ts' };
        const result = formatToolArguments('UnknownTool', args, workspacePath);
        expect(result).toBe('src/test.ts');
      });

      it('should fall back to generic formatting', () => {
        const args = { foo: 'bar', baz: 123 };
        const result = formatToolArguments('UnknownTool', args, workspacePath);
        expect(result).toContain('bar');
      });

      it('should handle empty args', () => {
        const result = formatToolArguments('UnknownTool', {}, workspacePath);
        expect(result).toBe('');
      });
    });
  });
});
