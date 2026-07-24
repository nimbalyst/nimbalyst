/**
 * Unit tests for ClaudeCodeSessionScanner
 * Tests token usage extraction from Claude Code JSONL files
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { encodeWorkspaceDir, extractSessionMetadata } from '../ClaudeCodeSessionScanner';

describe('ClaudeCodeSessionScanner', () => {
  describe('encodeWorkspaceDir', () => {
    // Mirrors `A.replace(/[^a-zA-Z0-9]/g, '-')` from the upstream Claude Code
    // CLI. Any drift here silently breaks workspace-filtered session imports
    // for users whose paths contain spaces, apostrophes, accented chars, etc.
    it('replaces forward slashes with dashes', () => {
      expect(encodeWorkspaceDir('/Users/foo/bar')).toBe('-Users-foo-bar');
    });

    it('replaces spaces with dashes', () => {
      expect(encodeWorkspaceDir('/Users/karlwirth/GitHub/Test Project')).toBe(
        '-Users-karlwirth-GitHub-Test-Project',
      );
    });

    it('replaces apostrophes with dashes', () => {
      expect(encodeWorkspaceDir("/Users/x/Lenny's Podcast")).toBe(
        '-Users-x-Lenny-s-Podcast',
      );
    });

    it('replaces accented characters with dashes', () => {
      expect(encodeWorkspaceDir('/tmp/Café/project')).toBe('-tmp-Caf--project');
    });

    it('replaces dots and underscores with dashes', () => {
      expect(encodeWorkspaceDir('/Users/foo/v2.0_alpha')).toBe(
        '-Users-foo-v2-0-alpha',
      );
    });

    it('preserves alphanumerics and existing dashes', () => {
      expect(encodeWorkspaceDir('/Users/foo/my-repo-2')).toBe(
        '-Users-foo-my-repo-2',
      );
    });
  });

  describe('extractSessionMetadata', () => {
    it('should extract token usage from actual Claude Code JSONL files', async () => {
      // Find a Claude Code session file with actual token usage (non-zero)
      const projectsDir = path.join(homedir(), '.claude', 'projects');

      let testFilePath: string | null = null;
      try {
        const workspaceDirs = await fs.readdir(projectsDir, { withFileTypes: true });

        for (const dir of workspaceDirs) {
          if (!dir.isDirectory()) continue;

          const workspaceDir = path.join(projectsDir, dir.name);
          const files = await fs.readdir(workspaceDir, { withFileTypes: true });

          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name.startsWith('agent-')) {
              continue;
            }

            const filePath = path.join(workspaceDir, file.name);

            // Quick check: does this file have non-zero tokens?
            const content = await fs.readFile(filePath, 'utf-8');
            if (content.includes('"output_tokens":') && /\"output_tokens\":\s*[1-9]/.test(content)) {
              testFilePath = filePath;
              break;
            }
          }

          if (testFilePath) break;
        }
      } catch (error) {
        // No Claude Code projects directory - skip test
        console.warn('No Claude Code projects directory found, skipping test');
        return;
      }

      if (!testFilePath) {
        console.warn('No Claude Code JSONL files with token usage found, skipping test');
        return;
      }

      // Extract metadata from the session file
      const metadata = await extractSessionMetadata(testFilePath);

      // Verify metadata was extracted
      expect(metadata).not.toBeNull();
      expect(metadata!.sessionId).toBeTruthy();
      expect(metadata!.workspacePath).toBeTruthy();
      expect(metadata!.messageCount).toBeGreaterThan(0);

      // Verify token usage is extracted
      expect(metadata!.tokenUsage).toBeDefined();
      expect(metadata!.tokenUsage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(metadata!.tokenUsage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(metadata!.tokenUsage.totalTokens).toBe(
        metadata!.tokenUsage.inputTokens + metadata!.tokenUsage.outputTokens
      );

      // Log results for debugging
      console.log('Test file:', testFilePath);
      console.log('Session ID:', metadata!.sessionId);
      console.log('Message count:', metadata!.messageCount);
      console.log('Token usage:', metadata!.tokenUsage);

      // At least one should be > 0 for a real session with assistant responses
      expect(
        metadata!.tokenUsage.inputTokens > 0 || metadata!.tokenUsage.outputTokens > 0
      ).toBe(true);
    });

    it('should correctly parse usage from message.usage field', async () => {
      // Create a minimal test JSONL with usage data
      const testJsonl = [
        {
          uuid: 'test-1',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'Hello' }
        },
        {
          uuid: 'test-2',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:01:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30000  // Should NOT be counted
            }
          }
        },
        {
          uuid: 'test-3',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:02:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Another response' }],
            usage: {
              input_tokens: 200,
              output_tokens: 75,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 40000  // Should NOT be counted
            }
          }
        }
      ].map(entry => JSON.stringify(entry)).join('\n');

      // Write to temp file
      const tmpDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'claude-test-'));
      const tmpFile = path.join(tmpDir, 'test-session.jsonl');
      await fs.writeFile(tmpFile, testJsonl, 'utf-8');

      try {
        const metadata = await extractSessionMetadata(tmpFile);

        expect(metadata).not.toBeNull();
        expect(metadata!.sessionId).toBe('test-session');
        expect(metadata!.messageCount).toBe(3);

        // Verify token totals - just message tokens, ignore cache
        // Input tokens: 100 + 200 = 300
        // Output tokens: 50 + 75 = 125
        // Total: 300 + 125 = 425
        expect(metadata!.tokenUsage.inputTokens).toBe(300);
        expect(metadata!.tokenUsage.outputTokens).toBe(125);
        expect(metadata!.tokenUsage.totalTokens).toBe(425);
      } finally {
        // Cleanup
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle sessions with no usage data', async () => {
      // Create a JSONL with no assistant messages
      const testJsonl = [
        {
          uuid: 'test-1',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'Hello' }
        }
      ].map(entry => JSON.stringify(entry)).join('\n');

      const tmpDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'claude-test-'));
      const tmpFile = path.join(tmpDir, 'test-session.jsonl');
      await fs.writeFile(tmpFile, testJsonl, 'utf-8');

      try {
        const metadata = await extractSessionMetadata(tmpFile);

        expect(metadata).not.toBeNull();
        expect(metadata!.tokenUsage.inputTokens).toBe(0);
        expect(metadata!.tokenUsage.outputTokens).toBe(0);
        expect(metadata!.tokenUsage.totalTokens).toBe(0);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should extract token usage from assistant messages with tool_use content', async () => {
      // Test that messages with only tool_use (no text) still contribute tokens
      const testJsonl = [
        {
          uuid: 'test-1',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'Read the file' }
        },
        {
          uuid: 'test-2',
          sessionId: 'test-session',
          timestamp: '2025-11-24T00:01:00.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'Read',
                input: { file_path: '/test/file.txt' }
              }
            ],
            usage: {
              input_tokens: 50,
              output_tokens: 25,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          }
        }
      ].map(entry => JSON.stringify(entry)).join('\n');

      const tmpDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'claude-test-'));
      const tmpFile = path.join(tmpDir, 'test-session.jsonl');
      await fs.writeFile(tmpFile, testJsonl, 'utf-8');

      try {
        const metadata = await extractSessionMetadata(tmpFile);

        expect(metadata).not.toBeNull();
        expect(metadata!.tokenUsage.inputTokens).toBe(50);
        expect(metadata!.tokenUsage.outputTokens).toBe(25);
        expect(metadata!.tokenUsage.totalTokens).toBe(75);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
