import type { ProviderStream } from './types';
import { streamOpenAI } from './openai';
import { streamAnthropic } from './anthropic';

export const providers: Record<string, ProviderStream> = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  lmstudio: streamOpenAI, // OpenAI-compatible API
};
