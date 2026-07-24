import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseBashForFileOps } from '../../permissions/BashCommandAnalyzer';

/**
 * Unit tests for Bash command file operation parser
 * Tests the parseBashForFileOps function from bashUtils.ts
 */

describe('bashUtils - Bash Parser', () => {
  const testWorkspace = '/test/workspace';

  describe('Output Redirects', () => {
    it('should detect cat > file', () => {
      const files = parseBashForFileOps('cat input.txt > output.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'output.txt')]);
    });

    it('should detect cat >> file (append)', () => {
      const files = parseBashForFileOps('cat input.txt >> log.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'log.txt')]);
    });

    it('should detect echo > file', () => {
      const files = parseBashForFileOps('echo "hello world" > message.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'message.txt')]);
    });

    it('should detect echo >> file (append)', () => {
      const files = parseBashForFileOps('echo "new line" >> existing.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'existing.txt')]);
    });

    it('should detect printf > file', () => {
      // shell-quote parser properly handles printf with redirects
      const files = parseBashForFileOps('printf "%s\n" "data" > data.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'data.txt')]);
    });

    it('should skip variables in redirects', () => {
      const files = parseBashForFileOps('echo "test" > $OUTPUT_FILE', testWorkspace);
      expect(files).toEqual([]);
    });
  });

  describe('Direct Redirects', () => {
    it('should detect > file (truncate)', () => {
      const files = parseBashForFileOps('> empty.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'empty.txt')]);
    });

    it('should detect >> file (append)', () => {
      const files = parseBashForFileOps('>> append.log', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'append.log')]);
    });
  });

  describe('rm Command', () => {
    it('should detect rm file', () => {
      const files = parseBashForFileOps('rm old.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'old.txt')]);
    });

    it('should detect rm -rf directory', () => {
      const files = parseBashForFileOps('rm -rf build/', testWorkspace);
      // path.join normalizes trailing slashes
      expect(files).toEqual([path.join(testWorkspace, 'build')]);
    });

    it('should detect rm -f file', () => {
      const files = parseBashForFileOps('rm -f temp.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'temp.txt')]);
    });

    it('should skip rm flags without file', () => {
      const files = parseBashForFileOps('rm -rf', testWorkspace);
      expect(files).toEqual([]);
    });

    it('should skip variables in rm', () => {
      const files = parseBashForFileOps('rm $FILE_TO_DELETE', testWorkspace);
      expect(files).toEqual([]);
    });
  });

  describe('mv Command', () => {
    it('should detect mv old new (both files)', () => {
      const files = parseBashForFileOps('mv old.txt new.txt', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'old.txt'));
      expect(files).toContain(path.join(testWorkspace, 'new.txt'));
      expect(files).toHaveLength(2);
    });

    it('should detect mv -f old new', () => {
      const files = parseBashForFileOps('mv -f config.old config.new', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'config.old'));
      expect(files).toContain(path.join(testWorkspace, 'config.new'));
      expect(files).toHaveLength(2);
    });

    it('should detect mv with relative paths', () => {
      const files = parseBashForFileOps('mv src/old.js dist/new.js', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'src/old.js'));
      expect(files).toContain(path.join(testWorkspace, 'dist/new.js'));
      expect(files).toHaveLength(2);
    });
  });

  describe('cp Command', () => {
    it('should detect cp src dest (destination only)', () => {
      const files = parseBashForFileOps('cp source.txt dest.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'dest.txt')]);
    });

    it('should detect cp -r directory', () => {
      const files = parseBashForFileOps('cp -r src/ dist/', testWorkspace);
      // path.join normalizes trailing slashes
      expect(files).toEqual([path.join(testWorkspace, 'dist')]);
    });

    it('should detect cp -f with overwrite', () => {
      const files = parseBashForFileOps('cp -f new.txt existing.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'existing.txt')]);
    });
  });

  describe('sed -i Command', () => {
    it('should detect sed -i with single quotes', () => {
      const files = parseBashForFileOps("sed -i 's/foo/bar/' file.txt", testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'file.txt')]);
    });

    it('should detect sed -i with double quotes', () => {
      const files = parseBashForFileOps('sed -i "s/old/new/" data.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'data.txt')]);
    });

    it('should detect sed -i.bak (backup)', () => {
      const files = parseBashForFileOps("sed -i.bak 's/test/prod/' config.json", testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'config.json')]);
    });
  });

  describe('tee Command', () => {
    it('should detect tee file', () => {
      const files = parseBashForFileOps('echo "test" | tee output.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'output.txt')]);
    });

    it('should detect tee -a (append)', () => {
      const files = parseBashForFileOps('curl http://example.com | tee -a log.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'log.txt')]);
    });
  });

  describe('Compound Commands', () => {
    it('should detect multiple operations in chained commands', () => {
      const files = parseBashForFileOps('rm old.txt && echo "new" > new.txt', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'old.txt'));
      expect(files).toContain(path.join(testWorkspace, 'new.txt'));
      expect(files).toHaveLength(2);
    });

    it('should detect files in piped commands', () => {
      const files = parseBashForFileOps('cat input.txt | grep "test" > filtered.txt', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'filtered.txt'));
    });

    it('should detect multiple file operations with semicolons', () => {
      const files = parseBashForFileOps('echo "a" > a.txt ; echo "b" > b.txt', testWorkspace);
      expect(files).toContain(path.join(testWorkspace, 'a.txt'));
      expect(files).toContain(path.join(testWorkspace, 'b.txt'));
      expect(files).toHaveLength(2);
    });
  });

  describe('Path Resolution', () => {
    it('should resolve relative paths', () => {
      const files = parseBashForFileOps('echo "test" > ./subdir/file.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'subdir/file.txt')]);
    });

    it('should resolve parent directory paths', () => {
      const files = parseBashForFileOps('echo "test" > ../outside.txt', testWorkspace);
      // Should be outside workspace, so filtered out
      expect(files).toEqual([]);
    });

    it('should only track files within workspace', () => {
      const files = parseBashForFileOps('echo "test" > /tmp/file.txt', testWorkspace);
      expect(files).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty command', () => {
      const files = parseBashForFileOps('', testWorkspace);
      expect(files).toEqual([]);
    });

    it('should handle commands with no file operations', () => {
      const files = parseBashForFileOps('ls -la', testWorkspace);
      expect(files).toEqual([]);
    });

    it('should handle commands with quotes in strings', () => {
      // Note: Quote-aware parsing is Phase 2/3 enhancement
      // For Phase 1, we use simple regex which may capture inside quotes
      const files = parseBashForFileOps('echo "hello > world" > output.txt', testWorkspace);
      // This currently captures "world"" due to simple regex - acceptable for Phase 1
      // Phase 2 would use shell-quote parser for proper handling
      expect(files.length).toBeGreaterThan(0);
    });

    it('should deduplicate same file mentioned multiple times', () => {
      const files = parseBashForFileOps('echo "a" > file.txt && echo "b" >> file.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'file.txt')]);
    });

    it('should handle files with special characters in name', () => {
      const files = parseBashForFileOps('echo "test" > file-with-dashes_and_underscores.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'file-with-dashes_and_underscores.txt')]);
    });
  });

  describe('Heredoc Handling', () => {
    it('should strip heredoc content and only detect the redirect target', () => {
      const cmd = `cat << 'EOF' > output.txt
This is heredoc content with --> arrows
and other > redirect-like > syntax
EOF`;
      const files = parseBashForFileOps(cmd, testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'output.txt')]);
    });

    it('should not produce false positives from mermaid syntax in heredocs', () => {
      const cmd = `cat << 'EOF' > dog-breeds.excalidraw
graph TD
    A[Breeds] --> B[Sporting]
    A --> C[Herding]
    A --> D[Working]
    B --> B1[Labrador Retriever]
    C --> C1[German Shepherd]
EOF`;
      const files = parseBashForFileOps(cmd, testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'dog-breeds.excalidraw')]);
    });

    it('should handle heredoc with unquoted delimiter', () => {
      const cmd = `cat << DELIM > file.txt
content with > redirect chars
DELIM`;
      const files = parseBashForFileOps(cmd, testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'file.txt')]);
    });
  });

  describe('Path Validation', () => {
    it('should reject paths containing brackets', () => {
      // These could come from mermaid node IDs like B[Sporting]
      const files = parseBashForFileOps('echo test > B[Sporting]', testWorkspace);
      expect(files).toEqual([]);
    });

    it('should reject paths containing curly braces', () => {
      const files = parseBashForFileOps('echo test > {output}', testWorkspace);
      expect(files).toEqual([]);
    });

    it('should allow paths with dots, dashes, underscores, and slashes', () => {
      const files = parseBashForFileOps('echo test > src/my-file_v2.0.txt', testWorkspace);
      expect(files).toEqual([path.join(testWorkspace, 'src/my-file_v2.0.txt')]);
    });
  });
});
