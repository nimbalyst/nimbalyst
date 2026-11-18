/** MiniMax image generation provider (global and China endpoints). */
import type { ImageProvider, GenerationRequest, GenerationResult, GeneratedImage, ProviderCapabilities } from '../types';

const ENDPOINTS = {
  global: 'https://api.minimax.io/v1/image_generation',
  china: 'https://api.minimaxi.com/v1/image_generation',
} as const;
const DEFAULT_MODEL = 'image-01';
const MODELS = ['image-01', 'image-01-live'] as const;

type MiniMaxResponse = {
  data?: { image_urls?: string[]; image_base64?: string[] };
  metadata?: { success_count?: number; failed_count?: number };
  base_resp?: { status_code?: number; status_msg?: string };
  error?: { message?: string };
};

function dimensions(aspectRatio: string): { width: number; height: number } {
  const sizes: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1408, height: 768 }, '9:16': { width: 768, height: 1408 },
    '4:3': { width: 1152, height: 896 }, '3:4': { width: 896, height: 1152 },
    '1:1': { width: 1024, height: 1024 },
  };
  return sizes[aspectRatio] || sizes['1:1'];
}

async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MiniMax image download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class MiniMaxImageProvider implements ImageProvider {
  id = 'minimax';
  name = 'MiniMax';
  capabilities: ProviderCapabilities = {
    styles: ['sketch', 'diagram', 'illustration', 'photorealistic', 'wireframe'],
    supportsVariations: true, supportsInpainting: false, maxImagesPerRequest: 4,
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'], supportsConversation: false,
  };
  private apiKey: string | null = null;
  private model: string = DEFAULT_MODEL;
  private region: keyof typeof ENDPOINTS = 'global';
  setApiKey(value: string): void { this.apiKey = value; }
  setModel(value: string): void { if (MODELS.includes(value as (typeof MODELS)[number])) this.model = value; }
  setRegion(value: keyof typeof ENDPOINTS): void { this.region = value; }
  isConfigured(): boolean { return Boolean(this.apiKey); }

  async generateImage(request: GenerationRequest): Promise<GenerationResult> {
    if (!this.apiKey) throw new Error('MiniMax API key is not configured. Add it in Image Generation settings.');
    const aspectRatio = request.aspectRatio || '1:1';
    const count = Math.min(4, Math.max(1, request.numVariations || 1));
    const response = await fetch(ENDPOINTS[this.region], {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: request.prompt, aspect_ratio: aspectRatio, n: count, response_format: 'url' }),
    });
    const data = await response.json() as MiniMaxResponse;
    if (!response.ok || data.base_resp?.status_code) throw new Error(data.base_resp?.status_msg || data.error?.message || `MiniMax API error (${response.status})`);
    const urls = data.data?.image_urls || [];
    const encoded = data.data?.image_base64 || [];
    const size = dimensions(aspectRatio);
    const images: GeneratedImage[] = [];
    for (let i = 0; i < Math.max(urls.length, encoded.length); i++) {
      const value = encoded[i] || (urls[i] ? await urlToBase64(urls[i]) : '');
      if (!value) continue;
      images.push({ file: `gen-${Date.now()}-${i}.png`, seed: request.seed ?? Math.floor(Math.random() * 1_000_000), width: size.width, height: size.height, _base64Data: value } as GeneratedImage & { _base64Data: string });
    }
    if (!images.length) throw new Error('MiniMax returned no generated images.');
    return { images, metadata: { provider: this.id, model: this.model, timestamp: new Date().toISOString() } };
  }
}

export const minimaxImageProvider = new MiniMaxImageProvider();
