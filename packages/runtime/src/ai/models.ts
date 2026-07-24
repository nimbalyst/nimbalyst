import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface AIModelInfo { id: string; name: string }

export async function getOpenAIModels(apiKey?: string, baseUrl?: string): Promise<AIModelInfo[]> {
  try {
    if (!apiKey) throw new Error('no key');
    const client = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const list = await client.models.list();
    return list.data.map((m: any) => ({ id: m.id, name: m.id }));
  } catch {
    // Fallback minimal list
    return [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      { id: 'gpt-4o', name: 'gpt-4o' },
      { id: 'gpt-4-turbo', name: 'gpt-4-turbo' },
    ];
  }
}

export async function getAnthropicModels(apiKey?: string, baseUrl?: string): Promise<AIModelInfo[]> {
  try {
    if (!apiKey) throw new Error('no key');
    const client = new Anthropic({ apiKey, baseURL: baseUrl });
    const res: any = await (client as any).models?.list?.();
    if (res?.data) return res.data.map((m: any) => ({ id: m.id, name: m.display_name || m.id }));
    throw new Error('no list');
  } catch {
    return [
      { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
    ];
  }
}

export async function getLMStudioModels(baseUrl: string): Promise<AIModelInfo[]> {
  try {
    const root = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${root}/models`);
    const data = await res.json();
    if (Array.isArray(data?.data)) {
      return data.data.map((m: any) => ({ id: m.id || m.name || m, name: m.id || m.name || m }));
    }
    return [];
  } catch {
    return [];
  }
}

