import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  MINIMAX_ENDPOINTS,
  MiniMaxProvider,
  resolveMiniMaxEndpoint,
} from '../MiniMaxProvider';

describe('MiniMaxProvider', () => {
  it('registers the configured models without removing either model', () => {
    expect(MiniMaxProvider.getModels()).toEqual([
      {
        id: 'minimax:MiniMax-M3',
        name: 'MiniMax-M3',
        provider: 'minimax',
        contextWindow: 1000000,
      },
      {
        id: 'minimax:MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        provider: 'minimax',
        contextWindow: 204800,
      },
    ]);
  });

  it('resolves both protocols in both regions', () => {
    expect(resolveMiniMaxEndpoint(MINIMAX_ENDPOINTS.global_en.openai)).toMatchObject({
      protocol: 'openai',
      region: 'global_en',
    });
    expect(resolveMiniMaxEndpoint(MINIMAX_ENDPOINTS.global_en.anthropic)).toMatchObject({
      protocol: 'anthropic',
      region: 'global_en',
    });
    expect(resolveMiniMaxEndpoint(MINIMAX_ENDPOINTS.cn_zh.openai)).toMatchObject({
      protocol: 'openai',
      region: 'cn_zh',
    });
    expect(resolveMiniMaxEndpoint(MINIMAX_ENDPOINTS.cn_zh.anthropic)).toMatchObject({
      protocol: 'anthropic',
      region: 'cn_zh',
    });
  });

  it('rejects endpoints outside the configured endpoint matrix', () => {
    expect(() => resolveMiniMaxEndpoint('https://example.com/v1')).toThrow('Unsupported MiniMax endpoint');
  });

  it('uses the selected endpoint when initializing either adapter', async () => {
    const openaiProvider = new MiniMaxProvider();
    await openaiProvider.initialize({
      apiKey: 'test-key',
      baseUrl: MINIMAX_ENDPOINTS.cn_zh.openai,
      model: MiniMaxProvider.getDefaultModel(),
    });
    expect((openaiProvider as any).config).toMatchObject({
      baseUrl: MINIMAX_ENDPOINTS.cn_zh.openai,
      model: 'MiniMax-M3',
    });
    expect((openaiProvider as any).delegate.openai.baseURL).toBe(MINIMAX_ENDPOINTS.cn_zh.openai);

    const anthropicProvider = new MiniMaxProvider();
    await anthropicProvider.initialize({
      apiKey: 'test-key',
      baseUrl: MINIMAX_ENDPOINTS.cn_zh.anthropic,
    });
    expect((anthropicProvider as any).config).toMatchObject({
      baseUrl: MINIMAX_ENDPOINTS.cn_zh.anthropic,
      model: 'MiniMax-M3',
    });
    expect((anthropicProvider as any).delegate.anthropic.baseURL).toBe(MINIMAX_ENDPOINTS.cn_zh.anthropic);

    openaiProvider.destroy();
    anthropicProvider.destroy();
  });

  it('captures the SDK request paths derived from the public base URLs', async () => {
    const requests: string[] = [];
    const captureFetch = async (input: RequestInfo | URL): Promise<Response> => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        id: 'test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'MiniMax-M3',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: MINIMAX_ENDPOINTS.global_en.openai,
      fetch: captureFetch,
    });
    await openai.chat.completions.create({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'test' }],
    });

    const anthropic = new Anthropic({
      apiKey: 'test-key',
      baseURL: MINIMAX_ENDPOINTS.global_en.anthropic,
      fetch: captureFetch,
    });
    await anthropic.messages.create({
      model: 'MiniMax-M3',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(requests).toEqual([
      `${MINIMAX_ENDPOINTS.global_en.openai}/chat/completions`,
      `${MINIMAX_ENDPOINTS.global_en.anthropic}/v1/messages`,
    ]);
  });
});
