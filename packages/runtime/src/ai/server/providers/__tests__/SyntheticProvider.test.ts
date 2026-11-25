import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SyntheticProvider } from '../SyntheticProvider';

// Mock the fetch API for testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SyntheticProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    it('throws an error without API key', async () => {
      const provider = new SyntheticProvider();
      await expect(
        provider.initialize({} as any)
      ).rejects.toThrow('API key is required for Synthetic.new provider');
    });

    it('initializes successfully with API key and baseUrl', async () => {
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.synthetic.new/openai/v1'
      });

      expect(provider['baseUrl']).toBe('https://api.synthetic.new/openai/v1');
    });

    it('uses default baseUrl if not provided', async () => {
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key'
      });

      expect(provider['baseUrl']).toBe('https://api.synthetic.new/openai/v1');
    });
  });

  describe('getModels', () => {
    it('returns default models when no API key provided', async () => {
      const models = await SyntheticProvider.getModels('');
      expect(models.length).toBeGreaterThan(0);
      models.forEach(model => {
        expect(model.provider).toBe('synthetic');
      });
    });

    it('fetches models from Synthetic.new API with valid API key', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'syn:coding', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct', max_tokens: 16384, context_length: 131072 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.synthetic.new/openai/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key'
          })
        })
      );

      expect(models.length).toBe(3);
      expect(models[0].id).toBe('synthetic:hf:Qwen/Qwen3.6-72B-Instruct');
      expect(models[0].name).toBe('Qwen 3.6 72B Instruct');
      expect(models[0].maxTokens).toBe(8192);
      expect(models[0].contextWindow).toBe(32768);
    });

    it('returns default models when fetch fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Failed to fetch models'));

      const models = await SyntheticProvider.getModels('test-api-key');
      expect(models).toEqual(SyntheticProvider.getDefaultModels());
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[SyntheticProvider] Failed to fetch models:',
        expect.any(Error)
      );
    });

    it('handles different model ID formats correctly', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'syn:coding', max_tokens: 8192, context_length: 32768 },
            { id: 'syn:chat', max_tokens: 4096, context_length: 16384 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      expect(models).toEqual([
        {
          id: 'synthetic:hf:Qwen/Qwen3.6-72B-Instruct',
          name: 'Qwen 3.6 72B Instruct',
          provider: 'synthetic',
          maxTokens: 8192,
          contextWindow: 32768
        },
        {
          id: 'synthetic:syn:coding',
          name: 'Synthetic Coding',
          provider: 'synthetic',
          maxTokens: 8192,
          contextWindow: 32768
        },
        {
          id: 'synthetic:syn:chat',
          name: 'Synthetic Chat',
          provider: 'synthetic',
          maxTokens: 4096,
          contextWindow: 16384
        }
      ]);
    });
  });

  describe('getDefaultModel', () => {
    it('returns the default model ID', () => {
      const model = SyntheticProvider.getDefaultModels()[0].id;
      const defaultModel = SyntheticProvider.getDefaultModel();

      expect(defaultModel).toBe(model);
    });
  });

  describe('getCapabilities', () => {
    it('returns correct capabilities', () => {
      const provider = new SyntheticProvider();

      const capabilities = provider.getCapabilities();

      expect(capabilities).toEqual({
        streaming: true,
        tools: true,
        mcpSupport: false,
        edits: true,
        resumeSession: false,
        supportsFileTools: false
      });
    });
  });

  describe('ModelIdentifier edge case', () => {
    it('handles model IDs with embedded colons (hf:org/model)', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct', max_tokens: 16384, context_length: 131072 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      // These should have 'synthetic:' prefix only, not twice (e.g. synthetic:hf:org/model)
      expect(models[0].id).toBe('synthetic:hf:Qwen/Qwen3.6-72B-Instruct');
      expect(models[1].id).toBe('synthetic:hf:meta-llama/Meta-Llama-3.1-405B-Instruct');
    });
  });

  describe('formatModelName', () => {
    it('formats model IDs correctly', () => {
      const name1 = SyntheticProvider['formatModelName']('hf:Qwen/Qwen3.6-72B-Instruct');
      expect(name1).toBe('Qwen 3.6 72B Instruct');

      const name2 = SyntheticProvider['formatModelName']('syn:coding');
      expect(name2).toBe('Synthetic Coding');

      const name3 = SyntheticProvider['formatModelName']('hf:meta-llama/Meta-Llama-3.1-405B-Instruct');
      expect(name3).toBe('Meta Llama 3.1 405B Instruct');

      const name4 = SyntheticProvider['formatModelName']('syn:chat-v2');
      expect(name4).toBe('Synthetic Chat V2');
    });
  });
});

// Opt-in integration test
const runSyntheticIntegration = process.env.RUN_SYNTHETIC_INTEGRATION === '1';

describe.skipIf(!runSyntheticIntegration)('SyntheticProvider live integration', () => {
  it('connects to real Synthetic.new API and streams a response', async () => {
    const apiKey = process.env.SYNTHETIC_API_KEY || '';

    if (!apiKey) {
      console.warn('SKIP: SYNTHETIC_API_KEY not set');
      return;
    }

    const provider = new SyntheticProvider();
    await provider.initialize({
      apiKey,
      model: 'syn:coding'
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('Say hello in a single sentence.', undefined, 'test-session')) {
      chunks.push(chunk);
      if (chunks.length === 1) break; // Just verify we can stream
    }

    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk).toBeDefined();
    expect(finalChunk.content).toBeDefined();
    expect(typeof finalChunk.content).toBe('string');
    expect(finalChunk.content.length).toBeGreaterThan(0);
  });
});