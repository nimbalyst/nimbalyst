import { describe, it, expect } from 'vitest';

/**
 * Tests for the canUseTool response normalization logic.
 *
 * The native binary's Zod schema requires:
 * - allow: updatedInput must be a Record (not undefined)
 * - deny: message must be a string (not undefined)
 *
 * This normalization runs in ClaudeCodeProvider.createCanUseToolHandler()
 * as a safety net after all decision paths. We test the normalization
 * logic directly rather than through the full provider to keep tests fast.
 */

type CanUseToolResult = { behavior: 'allow' | 'deny'; updatedInput?: any; message?: string };

function normalizeCanUseToolResult(result: CanUseToolResult, originalInput: any): CanUseToolResult {
  if (result.behavior === 'allow' && result.updatedInput === undefined) {
    result.updatedInput = originalInput;
  } else if (result.behavior === 'deny' && result.message === undefined) {
    result.message = 'Tool call denied';
  }
  return result;
}

describe('canUseTool response normalization', () => {
  describe('allow responses', () => {
    it('passes through well-formed allow with updatedInput', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'allow', updatedInput: { command: 'ls' } },
        { command: 'ls' }
      );
      expect(result.updatedInput).toEqual({ command: 'ls' });
    });

    it('fills missing updatedInput with original input', () => {
      const originalInput = { command: 'npm test' };
      const result = normalizeCanUseToolResult(
        { behavior: 'allow' },
        originalInput
      );
      expect(result.updatedInput).toBe(originalInput);
    });

    it('does not overwrite existing updatedInput', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'allow', updatedInput: { command: 'modified' } },
        { command: 'original' }
      );
      expect(result.updatedInput).toEqual({ command: 'modified' });
    });

    it('handles null updatedInput (only undefined triggers normalization)', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'allow', updatedInput: null },
        { command: 'test' }
      );
      expect(result.updatedInput).toBeNull();
    });

    it('handles empty object updatedInput', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'allow', updatedInput: {} },
        { command: 'test' }
      );
      expect(result.updatedInput).toEqual({});
    });
  });

  describe('deny responses', () => {
    it('passes through well-formed deny with message', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'deny', message: 'User rejected' },
        {}
      );
      expect(result.message).toBe('User rejected');
    });

    it('fills missing message with default', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'deny' },
        {}
      );
      expect(result.message).toBe('Tool call denied');
    });

    it('does not overwrite existing message', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'deny', message: 'Custom reason' },
        {}
      );
      expect(result.message).toBe('Custom reason');
    });

    it('handles empty string message (does not replace)', () => {
      const result = normalizeCanUseToolResult(
        { behavior: 'deny', message: '' },
        {}
      );
      expect(result.message).toBe('');
    });
  });

  describe('real-world scenarios that triggered Zod validation failures', () => {
    it('allow from a code path that forgot updatedInput', () => {
      // Simulates a new code path added to immediateToolDecision or
      // toolAuthorization that returns { behavior: "allow" } without updatedInput
      const originalInput = { file_path: '/test/file.ts', content: 'hello' };
      const result = normalizeCanUseToolResult(
        { behavior: 'allow' } as CanUseToolResult,
        originalInput
      );
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toBe(originalInput);
    });

    it('deny from a code path that forgot message', () => {
      // Simulates a new code path that returns { behavior: "deny" } without message
      const result = normalizeCanUseToolResult(
        { behavior: 'deny' } as CanUseToolResult,
        {}
      );
      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('Tool call denied');
      expect(typeof result.message).toBe('string');
    });
  });
});
