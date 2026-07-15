import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The runtime workspace is not pre-built when vitest runs in this package, so the
// subpath imports in aiServiceUtils.ts (`@nimbalyst/runtime/ai/server*`) fail to
// resolve. Stub the values + types we actually use; the helpers under test only
// touch ModelIdentifier.tryParse, OpenAICodexProvider.normalizeModelSelection,
// and the two const arrays.
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  OpenAICodexProvider: {
    normalizeModelSelection: (m: string) => {
      const normalized = m.trim().toLowerCase();
      if (
        normalized === 'openai-codex:openai-codex-cli' ||
        normalized === 'openai-codex-cli' ||
        normalized === 'openai-codex:default' ||
        normalized === 'default' ||
        normalized === 'openai-codex:cli' ||
        normalized === 'cli'
      ) {
        return 'openai-codex:gpt-5.6-sol';
      }
      return m;
    },
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    tryParse: (id: string) => {
      const colon = id.indexOf(':');
      if (colon < 0) return null;
      return { provider: id.slice(0, colon), model: id.slice(colon + 1) };
    },
  },
  CLAUDE_CODE_VARIANTS: ['opus', 'sonnet', 'haiku'] as const,
  AI_PROVIDER_TYPES: ['claude', 'claude-code', 'openai', 'openai-codex', 'minimax', 'lmstudio'] as const,
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../../HistoryManager', () => ({
  historyManager: {
    listSnapshots: vi.fn().mockResolvedValue([]),
    getLastReviewedTimestamp: vi.fn().mockResolvedValue(null),
    loadSnapshot: vi.fn(),
    getPendingTags: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  bucketMessageLength,
  bucketResponseTime,
  bucketChunkCount,
  bucketContentLength,
  bucketCount,
  bucketAgeInDays,
  detectConfiguredAIProvider,
  getFileExtensionForAnalytics,
  extractModelForProvider,
  extractFileMentions,
  formatCodexTestError,
  categorizeAIError,
  isCreateLikeChangeKind,
  detectNimbalystSlashCommand,
  previewForLog,
  LOG_PREVIEW_LENGTH,
} from '../aiServiceUtils';

describe('aiServiceUtils', () => {
  describe('bucketMessageLength', () => {
    it.each([
      [0, 'short'],
      [99, 'short'],
      [100, 'medium'],
      [499, 'medium'],
      [500, 'long'],
      [10_000, 'long'],
    ])('len=%i -> %s', (len, expected) => {
      expect(bucketMessageLength(len)).toBe(expected);
    });
  });

  describe('bucketResponseTime', () => {
    it.each([
      [0, 'fast'],
      [1999, 'fast'],
      [2000, 'medium'],
      [4999, 'medium'],
      [5000, 'slow'],
      [60_000, 'slow'],
    ])('ms=%i -> %s', (ms, expected) => {
      expect(bucketResponseTime(ms)).toBe(expected);
    });
  });

  describe('bucketChunkCount', () => {
    it.each([
      [0, '0-9'],
      [9, '0-9'],
      [10, '10-49'],
      [49, '10-49'],
      [50, '50-99'],
      [99, '50-99'],
      [100, '100+'],
      [9999, '100+'],
    ])('count=%i -> %s', (count, expected) => {
      expect(bucketChunkCount(count)).toBe(expected);
    });
  });

  describe('bucketContentLength', () => {
    it.each([
      [0, '0-99'],
      [99, '0-99'],
      [100, '100-499'],
      [499, '100-499'],
      [500, '500-999'],
      [999, '500-999'],
      [1000, '1000+'],
    ])('len=%i -> %s', (len, expected) => {
      expect(bucketContentLength(len)).toBe(expected);
    });
  });

  describe('bucketCount', () => {
    it.each([
      [0, '0'],
      [1, '1'],
      [2, '2-4'],
      [4, '2-4'],
      [5, '5-9'],
      [9, '5-9'],
      [10, '10+'],
      [1_000, '10+'],
    ])('count=%i -> %s', (count, expected) => {
      expect(bucketCount(count)).toBe(expected);
    });
  });

  describe('bucketAgeInDays', () => {
    const day = 24 * 60 * 60 * 1000;
    it.each([
      ['today', 0],
      ['1-day', 1],
      ['2-6-days', 3],
      ['1-4-weeks', 14],
      ['1-3-months', 60],
      ['3-months-plus', 180],
    ])('returns %s for an age of %i days', (expected, ageDays) => {
      expect(bucketAgeInDays(Date.now() - ageDays * day)).toBe(expected);
    });
  });

  describe('detectConfiguredAIProvider', () => {
    const ENV_KEYS = [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'XAI_API_KEY',
      'OPENAI_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'MISTRAL_API_KEY',
      'GROQ_API_KEY',
      'COHERE_API_KEY',
      'ANTHROPIC_API_KEY',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
      for (const k of ENV_KEYS) delete process.env[k];
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('returns null when no relevant env vars are set', () => {
      expect(detectConfiguredAIProvider()).toBeNull();
    });

    it('prefers Bedrock flag over everything else', () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      process.env.OPENAI_API_KEY = 'k';
      process.env.ANTHROPIC_API_KEY = 'k';
      expect(detectConfiguredAIProvider()).toBe('aws-bedrock');
    });

    it('prefers Vertex flag over Anthropic', () => {
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      process.env.ANTHROPIC_API_KEY = 'k';
      expect(detectConfiguredAIProvider()).toBe('google-vertex');
    });

    it('detects OpenAI before Anthropic', () => {
      process.env.OPENAI_API_KEY = 'k';
      process.env.ANTHROPIC_API_KEY = 'k';
      expect(detectConfiguredAIProvider()).toBe('openai');
    });

    it('falls back to Anthropic when only ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      expect(detectConfiguredAIProvider()).toBe('anthropic');
    });

    it('detects each non-default provider', () => {
      const cases: Array<[string, string]> = [
        ['XAI_API_KEY', 'xai'],
        ['AZURE_OPENAI_API_KEY', 'azure-openai'],
        ['GEMINI_API_KEY', 'gemini'],
        ['MISTRAL_API_KEY', 'mistral'],
        ['GROQ_API_KEY', 'groq'],
        ['COHERE_API_KEY', 'cohere'],
      ];
      for (const [envKey, expected] of cases) {
        for (const k of ENV_KEYS) delete process.env[k];
        process.env[envKey] = 'k';
        expect(detectConfiguredAIProvider()).toBe(expected);
      }
    });
  });

  describe('getFileExtensionForAnalytics', () => {
    it('returns undefined for missing input', () => {
      expect(getFileExtensionForAnalytics(undefined)).toBeUndefined();
    });

    it('extracts a simple extension lowercased', () => {
      expect(getFileExtensionForAnalytics('Notes.MD')).toBe('.md');
    });

    it('returns undefined for files with no extension', () => {
      expect(getFileExtensionForAnalytics('Makefile')).toBeUndefined();
    });

    it('recognises the compound .mockup.html extension', () => {
      expect(getFileExtensionForAnalytics('design/foo.mockup.html')).toBe('.mockup.html');
    });

    it('uses only the trailing extension for non-compound names', () => {
      expect(getFileExtensionForAnalytics('archive.tar.gz')).toBe('.gz');
    });
  });

  describe('extractModelForProvider', () => {
    it('strips the openai-codex: prefix', () => {
      expect(extractModelForProvider('openai-codex:gpt-5', 'openai-codex')).toBe('gpt-5');
    });

    it('maps legacy openai-codex default aliases through provider normalization', () => {
      expect(extractModelForProvider('openai-codex:openai-codex-cli', 'openai-codex')).toBe('gpt-5.6-sol');
      expect(extractModelForProvider('openai-codex:default', 'openai-codex')).toBe('gpt-5.6-sol');
    });

    it('normalizes legacy Codex aliases for ACP sessions', () => {
      expect(extractModelForProvider('openai-codex-acp:default', 'openai-codex-acp')).toBe('gpt-5.6-sol');
    });

    it('returns the full model unchanged for claude-code', () => {
      expect(extractModelForProvider('claude-code:opus-1m', 'claude-code')).toBe('claude-code:opus-1m');
    });

    it('returns the model part for combined IDs on matching providers', () => {
      expect(extractModelForProvider('claude:claude-3-5-sonnet', 'claude')).toBe('claude-3-5-sonnet');
      expect(extractModelForProvider('openai:gpt-5', 'openai')).toBe('gpt-5');
    });

    it('returns null when a Claude Code variant is paired with a non-claude-code provider', () => {
      expect(extractModelForProvider('claude-code:opus', 'claude')).toBeNull();
    });

    it('returns null when a bare Claude Code variant is paired with the claude provider', () => {
      expect(extractModelForProvider('opus', 'claude')).toBeNull();
      expect(extractModelForProvider('SONNET', 'claude')).toBeNull();
    });

    it('returns null when the model string is just a provider name', () => {
      expect(extractModelForProvider('openai', 'claude')).toBeNull();
    });

    it('returns the raw model when no provider prefix is present', () => {
      expect(extractModelForProvider('gpt-5-turbo', 'openai')).toBe('gpt-5-turbo');
    });
  });

  describe('extractFileMentions', () => {
    it('returns an empty list when no mentions are present', () => {
      expect(extractFileMentions('Hello there')).toEqual([]);
    });

    it('extracts a single bare mention', () => {
      expect(extractFileMentions('see @path/to/file.ts please')).toEqual(['path/to/file.ts']);
    });

    it('extracts quoted mentions containing spaces', () => {
      expect(extractFileMentions('open @"path with spaces/file.md" now')).toEqual(['path with spaces/file.md']);
    });

    it('extracts multiple mentions in order', () => {
      expect(extractFileMentions('@a.md and @b.ts and @"c d.md"')).toEqual(['a.md', 'b.ts', 'c d.md']);
    });
  });

  describe('formatCodexTestError', () => {
    it('returns invalid-key copy when an api key is configured', () => {
      expect(formatCodexTestError('Unauthorized 401', true)).toMatch(/Invalid API key/);
    });

    it('returns CLI-login copy when no api key is configured', () => {
      expect(formatCodexTestError('Unauthorized 401', false)).toMatch(/log.*in.*Codex CLI|API key/);
    });

    it('translates exit-code crashes into user-friendly copy', () => {
      expect(formatCodexTestError('Codex Exec exited with code 1: ...', true)).toMatch(/Connection failed/);
    });

    it('translates network errors', () => {
      expect(formatCodexTestError('fetch failed: ECONNREFUSED', true)).toMatch(/Network error/);
    });

    it('translates rate-limit errors', () => {
      expect(formatCodexTestError('429 Too Many Requests', true)).toMatch(/Rate limited/);
    });

    it('falls through to the raw error when no rule matches', () => {
      expect(formatCodexTestError('something weird', true)).toBe('something weird');
    });
  });

  describe('categorizeAIError', () => {
    it.each<[string, string]>([
      ['session resume mismatch detected', 'resume_mismatch'],
      ['Stream closed unexpectedly', 'stream_closed'],
      ['ECONNREFUSED while contacting upstream', 'network'],
      ['Network error', 'network'],
      ['fetch failed', 'network'],
      ['Invalid API key supplied', 'auth'],
      ['401 Unauthorized', 'auth'],
      ['Authentication required', 'auth'],
      ['Request timed out', 'timeout'],
      ['Rate limit exceeded', 'rate_limit'],
      ['Too many requests', 'rate_limit'],
      ['The model is overloaded', 'overloaded'],
      ['Capacity exceeded', 'overloaded'],
      ['something we have not seen before', 'unknown'],
    ])('"%s" -> %s', (msg, expected) => {
      expect(categorizeAIError(new Error(msg))).toBe(expected);
    });

    it('accepts raw strings as well as Error-like objects', () => {
      expect(categorizeAIError('rate limit exceeded')).toBe('rate_limit');
    });

    it('returns "unknown" for null/undefined', () => {
      expect(categorizeAIError(null)).toBe('unknown');
      expect(categorizeAIError(undefined)).toBe('unknown');
    });

    it('prefers resume_mismatch over generic auth/network when both are present', () => {
      // A real error message from a stream resume failure — would otherwise
      // false-positive against "network" because it contains "fetch".
      expect(
        categorizeAIError(new Error('session resume mismatch (fetch retry exhausted)')),
      ).toBe('resume_mismatch');
    });

    it('prefers stream_closed over generic network', () => {
      expect(
        categorizeAIError(new Error('stream closed by peer; ECONNREFUSED')),
      ).toBe('stream_closed');
    });
  });

  describe('isCreateLikeChangeKind', () => {
    it.each([
      ['create', true],
      ['CREATE', true],
      ['Add', true],
      ['new', true],
      ['edit', false],
      ['delete', false],
      ['', false],
      [undefined, false],
    ])('kind=%s -> %s', (kind, expected) => {
      expect(isCreateLikeChangeKind(kind)).toBe(expected);
    });
  });

  describe('detectNimbalystSlashCommand', () => {
    it('always returns null (tool packages have been replaced by extensions)', () => {
      expect(detectNimbalystSlashCommand('/anything goes here', '/some/workspace')).toBeNull();
      expect(detectNimbalystSlashCommand('', undefined)).toBeNull();
    });
  });

  describe('previewForLog', () => {
    it('returns an empty string for missing input', () => {
      expect(previewForLog(undefined)).toBe('');
    });

    it('returns the value unchanged when shorter than the limit', () => {
      expect(previewForLog('hello')).toBe('hello');
    });

    it('truncates to the default limit and appends an ellipsis', () => {
      const long = 'x'.repeat(LOG_PREVIEW_LENGTH + 50);
      const out = previewForLog(long);
      expect(out.length).toBe(LOG_PREVIEW_LENGTH + 1); // +1 for the ellipsis char
      expect(out.endsWith('…')).toBe(true);
    });

    it('respects an explicit max', () => {
      expect(previewForLog('abcdefghij', 4)).toBe('abcd…');
    });
  });
});
