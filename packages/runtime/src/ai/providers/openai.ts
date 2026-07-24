import OpenAI from 'openai';
import type { ProviderStream, ProviderStreamParams } from './types';
import { toolRegistry, ToolExecutor } from '../tools';

function normalizeBaseUrl(baseUrl?: string) {
  if (!baseUrl) return undefined; // use default
  let root = baseUrl.replace(/\/$/, '');
  if (!/\/v1$/.test(root)) root += '/v1';
  return root;
}

export const streamOpenAI: ProviderStream = async function* (
  { model, apiKey, baseUrl, system, user, history }: ProviderStreamParams,
  signal?: AbortSignal
) {
  const client = new OpenAI({
    apiKey,
    baseURL: normalizeBaseUrl(baseUrl),
    dangerouslyAllowBrowser: true,
  });

  const hist = Array.isArray(history) ? history : [];
  const messages: OpenAI.Chat.Completions.ChatCompletionCreateParams['messages'] = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...((hist.map(m => ({ role: m.role, content: m.content })) as any[])),
    { role: 'user', content: user },
  ];

  // eslint-disable-next-line no-console
  try { console.log('[ai] OpenAI SDK stream ->', client.baseURL || 'https://api.openai.com/v1', { model }); } catch {}

  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: toolRegistry.toOpenAI(),
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true }, // Request usage data in streaming response
  }, { signal });

  const accum: Record<number, { name?: string; args: string }> = {};
  for await (const chunk of stream as any) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) {
      yield delta.content;
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!accum[idx]) accum[idx] = { args: '' };
        if (tc.function?.name) accum[idx].name = tc.function.name;
        if (tc.function?.arguments) accum[idx].args += tc.function.arguments;
      }
    }
    if (choice?.finish_reason === 'tool_calls') {
      for (const idxStr in accum) {
        const idx = Number(idxStr);
        const entry = accum[idx];
        try {
          const args = entry.args ? JSON.parse(entry.args) : {};
          if (entry.name) await ToolExecutor.execute(entry.name, args);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[ai] tool exec error', e);
          throw e;
        }
      }
    }
  }
};
