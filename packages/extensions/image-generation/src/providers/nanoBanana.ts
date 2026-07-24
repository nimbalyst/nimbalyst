/**
 * Nano Banana (Google Gemini/Imagen) Provider
 *
 * Implementation using Google's Gemini API for image generation.
 * Supports both:
 * - Single-shot generation via Imagen 4 model
 * - Multi-turn conversational editing via Gemini model
 *
 * API Documentation:
 * - Imagen: https://ai.google.dev/gemini-api/docs/imagen
 * - Gemini Image Gen: https://ai.google.dev/gemini-api/docs/image-generation
 */

import type {
  ImageProvider,
  GenerationRequest,
  GenerationResult,
  GeneratedImage,
  ProviderCapabilities,
  ConversationMessage,
  GeminiImageModel,
} from '../types';
import { DEFAULT_MODEL, AVAILABLE_MODELS } from '../types';

/**
 * Base API endpoint for Gemini models
 */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Response structure from Imagen API (single-shot)
 */
interface ImagenApiResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
    raiFilteredReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Response structure from Gemini API (multi-turn)
 */
interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
        thoughtSignature?: string;
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Style prompt modifiers to enhance generation quality
 */
const STYLE_PROMPTS: Record<string, string> = {
  sketch:
    'hand-drawn sketch style, pencil drawing, line art, architectural sketch, clean lines',
  diagram:
    'technical diagram, flowchart style, clean geometric shapes, professional infographic, vector style',
  illustration:
    'digital illustration, colorful, vector art style, modern graphic design',
  photorealistic:
    'photorealistic, high detail, realistic lighting, professional photography',
  wireframe:
    'UI wireframe, grayscale, simple shapes, low fidelity mockup, user interface sketch',
};

/**
 * Nano Banana provider implementation using Google Imagen/Gemini API
 */
export class NanoBananaProvider implements ImageProvider {
  id = 'nano-banana';
  name = 'Google Imagen';

  capabilities: ProviderCapabilities = {
    styles: ['sketch', 'diagram', 'illustration', 'photorealistic', 'wireframe'],
    supportsVariations: true,
    supportsInpainting: false,
    maxImagesPerRequest: 4,
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    supportsConversation: true, // Via Gemini model
  };

  private apiKey: string | null = null;
  private model: GeminiImageModel = DEFAULT_MODEL;

  /**
   * Set the API key for authentication
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Get the current API key
   */
  getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * Set the model to use for generation
   */
  setModel(model: GeminiImageModel): void {
    this.model = model;
    console.log('[Provider] Model set to:', model);
  }

  /**
   * Get the current model
   */
  getModel(): GeminiImageModel {
    return this.model;
  }

  /**
   * Check if the provider is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  /**
   * Check if the current model supports conversation/multi-turn
   */
  supportsConversation(): boolean {
    const modelConfig = AVAILABLE_MODELS.find(m => m.id === this.model);
    return modelConfig?.supportsConversation ?? true;
  }

  /**
   * Build the enhanced prompt with style modifiers
   */
  private buildPrompt(prompt: string, style?: string): string {
    const styleModifier = style && STYLE_PROMPTS[style] ? STYLE_PROMPTS[style] : '';
    if (styleModifier) {
      return `${prompt}. Style: ${styleModifier}`;
    }
    return prompt;
  }

  /**
   * Generate images from a prompt
   * Uses the selected model - falls back to single-shot if model doesn't support conversation
   */
  async generateImage(request: GenerationRequest): Promise<GenerationResult> {
    console.log('[Provider] Generate request with model:', this.model, request);

    if (!this.isConfigured()) {
      throw new Error(
        'Google AI is not configured. Please add your Google AI API key in Settings > Extensions > Image Generation.'
      );
    }

    // For Gemini models, use the unified endpoint
    // If there's conversation history and model supports it, include history
    const hasHistory = request.conversationHistory && request.conversationHistory.length > 0;
    if (hasHistory && this.supportsConversation()) {
      return this.generateWithConversation(request);
    }

    // Single-shot generation with Gemini
    return this.generateSingleShot(request);
  }

  /**
   * Generate images using Gemini API with conversation history
   * This enables iterative refinement of images
   */
  private async generateWithConversation(
    request: GenerationRequest
  ): Promise<GenerationResult> {
    console.log('[Gemini] Multi-turn generation with model:', this.model, 'history:', request.conversationHistory?.length, 'messages');

    const enhancedPrompt = this.buildPrompt(request.prompt, request.style);

    // Build the contents array with conversation history
    const contents: Array<{
      role: string;
      parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    }> = [];

    // Add conversation history
    if (request.conversationHistory) {
      for (const msg of request.conversationHistory) {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

        if (msg.text) {
          parts.push({ text: msg.text });
        }

        if (msg.imageBase64) {
          parts.push({
            inlineData: {
              mimeType: msg.imageMimeType || 'image/png',
              data: msg.imageBase64,
            },
          });
        }

        if (parts.length > 0) {
          contents.push({
            role: msg.role,
            parts,
          });
        }
      }
    }

    // Add the current prompt
    contents.push({
      role: 'user',
      parts: [{ text: enhancedPrompt }],
    });

    const aspectRatio = request.aspectRatio || '1:1';
    const requestBody = {
      contents,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio,
        },
      },
    };

    const endpoint = `${GEMINI_API_BASE}/${this.model}:generateContent`;
    console.log('[Gemini] Request to:', endpoint);
    console.log('[Gemini] Request body:', JSON.stringify(requestBody, null, 2).slice(0, 500) + '...');

    try {
      const response = await fetch(`${endpoint}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Gemini] API error:', response.status, errorText);
        this.handleApiError(response.status, errorText);
      }

      const data: GeminiApiResponse = await response.json();
      console.log('[Gemini] API response received');

      if (data.error) {
        throw new Error(data.error.message || 'Unknown API error');
      }

      return this.processGeminiResponse(data, request.aspectRatio || '1:1');
    } catch (error) {
      console.error('[Gemini] Generation failed:', error);
      throw error;
    }
  }

  /**
   * Process Gemini API response into GenerationResult
   */
  private processGeminiResponse(
    data: GeminiApiResponse,
    aspectRatio: string
  ): GenerationResult {
    const timestamp = new Date().toISOString();
    const images: GeneratedImage[] = [];
    let description: string | undefined;
    let thoughtSignature: string | undefined;

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No response from Gemini. The prompt may have been filtered.');
    }

    const candidate = data.candidates[0];
    const parts = candidate.content?.parts || [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // Extract text description
      if (part.text) {
        description = part.text;
      }

      // Extract thought signature for context preservation
      if (part.thoughtSignature) {
        thoughtSignature = part.thoughtSignature;
      }

      // Extract image
      if (part.inlineData?.data) {
        const filename = `gen-${Date.now()}-${i}.png`;
        images.push({
          file: filename,
          seed: Math.floor(Math.random() * 1000000),
          width: this.getWidthForAspectRatio(aspectRatio),
          height: this.getHeightForAspectRatio(aspectRatio),
          _base64Data: part.inlineData.data,
        } as GeneratedImage & { _base64Data: string });
      }
    }

    // Text-only responses are valid - the model might be asking for clarification,
    // answering a question, or describing what it will do

    console.log('[Gemini] Successfully processed', images.length, 'images');

    return {
      images,
      metadata: {
        provider: this.id,
        model: this.model,
        timestamp,
      },
      description,
      thoughtSignature,
    };
  }

  /**
   * Generate images using Gemini API (single-shot, no conversation history)
   */
  private async generateSingleShot(request: GenerationRequest): Promise<GenerationResult> {
    console.log('[Gemini] Single-shot generation with model:', this.model);

    const aspectRatio = request.aspectRatio || '1:1';
    const enhancedPrompt = this.buildPrompt(request.prompt, request.style);

    console.log('[Gemini] Enhanced prompt:', enhancedPrompt);

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: enhancedPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio,
        },
      },
    };

    const endpoint = `${GEMINI_API_BASE}/${this.model}:generateContent`;
    console.log('[Gemini] Request to:', endpoint);

    try {
      const response = await fetch(`${endpoint}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Gemini] API error:', response.status, errorText);
        this.handleApiError(response.status, errorText);
      }

      const data: GeminiApiResponse = await response.json();
      console.log('[Gemini] API response received');

      if (data.error) {
        throw new Error(data.error.message || 'Unknown API error');
      }

      return this.processGeminiResponse(data, aspectRatio);
    } catch (error) {
      console.error('[Gemini] Generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate images using Imagen API (dedicated image model)
   */
  private async generateWithImagen(request: GenerationRequest): Promise<GenerationResult> {
    console.log('[Imagen] Generation with model:', this.model);

    const numImages = Math.min(4, Math.max(1, request.numVariations || 1));
    const aspectRatio = request.aspectRatio || '1:1';
    const enhancedPrompt = this.buildPrompt(request.prompt, request.style);

    console.log('[Imagen] Enhanced prompt:', enhancedPrompt);
    console.log('[Imagen] Requesting', numImages, 'images with aspect ratio', aspectRatio);

    // Build the request body for Imagen predict endpoint
    const requestBody = {
      instances: [
        {
          prompt: enhancedPrompt,
        },
      ],
      parameters: {
        sampleCount: numImages,
        aspectRatio: aspectRatio,
      },
    };

    const endpoint = `${GEMINI_API_BASE}/${this.model}:predict`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey!,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Imagen] API error:', response.status, errorText);
        this.handleApiError(response.status, errorText);
      }

      const data: ImagenApiResponse = await response.json();
      console.log('[Imagen] API response received, predictions:', data.predictions?.length);

      if (data.error) {
        throw new Error(data.error.message || 'Unknown API error');
      }

      if (!data.predictions || data.predictions.length === 0) {
        throw new Error('No images were generated. The prompt may have been filtered.');
      }

      // Process the predictions into GeneratedImage objects
      const timestamp = new Date().toISOString();
      const images: GeneratedImage[] = [];

      for (let i = 0; i < data.predictions.length; i++) {
        const prediction = data.predictions[i];

        if (prediction.raiFilteredReason) {
          console.warn('[Imagen] Image filtered:', prediction.raiFilteredReason);
          continue;
        }

        if (!prediction.bytesBase64Encoded) {
          console.warn('[Imagen] Prediction missing image data');
          continue;
        }

        // Generate a unique filename
        const filename = `gen-${Date.now()}-${i}.png`;

        images.push({
          file: filename,
          seed: Math.floor(Math.random() * 1000000), // Imagen doesn't return seeds
          width: this.getWidthForAspectRatio(aspectRatio),
          height: this.getHeightForAspectRatio(aspectRatio),
          // Store base64 data temporarily for saving
          _base64Data: prediction.bytesBase64Encoded,
        } as GeneratedImage & { _base64Data: string });
      }

      if (images.length === 0) {
        throw new Error(
          'All generated images were filtered. Try adjusting your prompt to be more appropriate.'
        );
      }

      console.log('[Imagen] Successfully generated', images.length, 'images');

      return {
        images,
        metadata: {
          provider: this.id,
          model: this.model,
          timestamp,
        },
      };
    } catch (error) {
      console.error('[Imagen] Generation failed:', error);
      throw error;
    }
  }

  /**
   * Handle API errors consistently
   */
  private handleApiError(status: number, errorText: string): never {
    if (status === 401 || status === 403) {
      throw new Error(
        'Invalid Google AI API key. Please check your API key in Settings > Extensions > Image Generation.'
      );
    }
    if (status === 429) {
      throw new Error('Rate limit exceeded. Please wait a moment and try again.');
    }
    if (status === 400) {
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.error?.message || 'Invalid request to API');
      } catch {
        throw new Error('Invalid request to API');
      }
    }
    throw new Error(`API error: ${status}`);
  }

  /**
   * Get width for aspect ratio
   */
  private getWidthForAspectRatio(aspectRatio: string): number {
    const widthMap: Record<string, number> = {
      '1:1': 1024,
      '16:9': 1408,
      '9:16': 768,
      '4:3': 1152,
      '3:4': 896,
    };
    return widthMap[aspectRatio] || 1024;
  }

  /**
   * Get height for aspect ratio
   */
  private getHeightForAspectRatio(aspectRatio: string): number {
    const heightMap: Record<string, number> = {
      '1:1': 1024,
      '16:9': 768,
      '9:16': 1408,
      '4:3': 896,
      '3:4': 1152,
    };
    return heightMap[aspectRatio] || 1024;
  }
}

/**
 * Singleton instance of the Nano Banana provider
 */
export const nanoBananaProvider = new NanoBananaProvider();
