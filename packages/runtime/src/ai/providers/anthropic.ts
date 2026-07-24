import Anthropic from '@anthropic-ai/sdk';
import type { ProviderStream, ProviderStreamParams } from './types';
import { toolRegistry, ToolExecutor } from '../tools';

export const streamAnthropic: ProviderStream = async function* (
  { model, apiKey, baseUrl, system, user, history }: ProviderStreamParams,
  signal?: AbortSignal
) {
  const client = new Anthropic({ apiKey, baseURL: baseUrl });
  // SDK supports streaming events via .messages.create with stream: true
  // eslint-disable-next-line no-console
  try { console.log('[ai] Anthropic SDK stream ->', baseUrl || 'https://api.anthropic.com', { model }); } catch {}
  const hist = Array.isArray(history) ? history : [];
  const stream = await client.messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [
      ...((hist.map(m => ({ role: m.role, content: m.content })) as any[])),
      { role: 'user', content: user }
    ],
    // tools: toolRegistry.toAnthropic(), // Tools not supported in streaming API for current SDK
    stream: true,
  }, { signal });

  // The SDK returns an async iterator over events
  // We forward only text deltas
  // Types vary by SDK version; use duck-typing
  const toolMap: Record<string, { name?: string; args: string }> = {};
  for await (const ev of stream as any) {
    // Text streaming
    if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      yield ev.delta.text;
      continue;
    }
    // Tool use start
    if (ev?.type === 'content_block_start' && ev?.content_block?.type === 'tool_use') {
      const id = ev.content_block.id;
      toolMap[id] = { name: ev.content_block.name, args: '' };
      continue;
    }
    // Tool args delta (partial JSON)
    if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
      const id = ev?.content_block?.id;
      if (id && toolMap[id]) toolMap[id].args += ev.delta.partial_json;
      continue;
    }
    // Tool use end → execute
    if (ev?.type === 'content_block_stop' && ev?.content_block?.type === 'tool_use') {
      const id = ev.content_block.id;
      const entry = toolMap[id];
      if (entry && entry.name) {
        try {
          const args = entry.args ? JSON.parse(entry.args) : {};
          await ToolExecutor.execute(entry.name, args);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[ai] anthropic tool exec error', e);
          throw e;
        }
      }
      delete toolMap[id];
      continue;
    }
  }
};
