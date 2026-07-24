export interface ProviderStreamParams {
  model: string;
  apiKey: string;
  baseUrl?: string;
  system?: string;
  user: string;
  history?: { role: 'user'|'assistant'; content: string }[];
}

export type ProviderStream = (params: ProviderStreamParams, signal?: AbortSignal) => AsyncGenerator<string, void, unknown>;
