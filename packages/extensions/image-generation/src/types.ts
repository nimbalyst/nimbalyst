/**
 * Type definitions for Image Generation Extension
 */

// Supported image generation styles
export type ImageStyle =
  | 'sketch'
  | 'diagram'
  | 'illustration'
  | 'photorealistic'
  | 'wireframe'
  | 'custom';

// Supported aspect ratios
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

/**
 * A single generated image result
 */
export interface GeneratedImage {
  /** Filename within the .imgproj.images folder */
  file: string;
  /** Random seed used for generation */
  seed: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
}

/**
 * A single generation request and its results
 */
export interface Generation {
  /** Unique identifier for this generation */
  id: string;
  /** The prompt used for generation */
  prompt: string;
  /** Style preset used */
  style: ImageStyle;
  /** Aspect ratio used */
  aspectRatio: AspectRatio;
  /** Provider-specific parameters */
  parameters: Record<string, unknown>;
  /** When the generation was created */
  timestamp: string;
  /** Array of generated image results */
  results: GeneratedImage[];
  /** Error message if generation failed */
  error?: string;
}

/**
 * Project settings
 */
export interface ProjectSettings {
  /** Default style for new generations */
  defaultStyle: ImageStyle;
  /** Number of variations to generate per prompt */
  variationsPerPrompt: number;
  /** Default aspect ratio */
  defaultAspectRatio?: AspectRatio;
}

// ============================================================================
// Session-Based Architecture (v2)
// ============================================================================

/**
 * A message in the image generation conversation
 */
export interface SessionMessage {
  /** Unique identifier for this message */
  id: string;
  /** Role: user for prompts, assistant for generations */
  role: 'user' | 'assistant';
  /** When this message was created */
  timestamp: string;

  // User messages have text content
  /** The user's prompt or refinement request */
  content?: string;

  // Assistant messages have generation results
  /** The generation result (for assistant messages) */
  generation?: Generation;

  /** Description of what was done (for assistant messages) */
  description?: string;

  /** Thought signature for context preservation (from Gemini API) */
  thoughtSignature?: string;
}

/**
 * Session-level settings
 */
export interface SessionSettings {
  /** Style preset for this session */
  style: ImageStyle;
  /** Aspect ratio for this session */
  aspectRatio: AspectRatio;
}

/**
 * A conversation session for iterative image refinement
 */
export interface ImageSession {
  /** Unique identifier for this session */
  id: string;
  /** User-provided name (e.g., "Logo Design v2") */
  name?: string;
  /** When the session was created */
  created: string;
  /** When the session was last updated */
  updated: string;
  /** Conversation messages in chronological order */
  messages: SessionMessage[];
  /** Session-level settings */
  settings: SessionSettings;
}

/**
 * The .imgproj file format (v2 with sessions)
 */
export interface ImageProjectV2 {
  /** File format version - must be 2 */
  version: 2;
  /** Project name */
  name: string;
  /** Creation timestamp */
  created: string;
  /** Provider ID (e.g., "gemini") */
  provider: string;
  /** Conversation sessions */
  sessions: ImageSession[];
  /** Currently active session ID */
  activeSessionId?: string;
  /** Project-level default settings */
  settings: ProjectSettings;
}

/**
 * The .imgproj file format (v1 - legacy, single-shot generations)
 */
export interface ImageProjectV1 {
  /** File format version - must be 1 */
  version: 1;
  /** Project name */
  name: string;
  /** Creation timestamp */
  created: string;
  /** Provider ID */
  provider: string;
  /** Array of generations in reverse chronological order (newest first) */
  generations: Generation[];
  /** Project settings */
  settings: ProjectSettings;
}

/**
 * Union type for any version of ImageProject
 */
export type ImageProject = ImageProjectV1 | ImageProjectV2;

/**
 * Type guard for v2 projects
 */
export function isProjectV2(project: ImageProject): project is ImageProjectV2 {
  return project.version === 2;
}

/**
 * Type guard for v1 projects
 */
export function isProjectV1(project: ImageProject): project is ImageProjectV1 {
  return project.version === 1;
}

/**
 * Convert a v1 project to v2 format
 * Creates a single session from all existing generations
 */
export function migrateProjectV1ToV2(v1: ImageProjectV1): ImageProjectV2 {
  const sessionId = `session-${Date.now()}`;
  const now = new Date().toISOString();

  // v1 generations are stored newest-first, so reverse for chronological order
  const chronologicalGenerations = [...v1.generations].reverse();

  // Convert each generation to a pair of messages (user prompt + assistant response)
  const messages: SessionMessage[] = [];
  for (const gen of chronologicalGenerations) {
    // User message with the prompt
    messages.push({
      id: `msg-user-${gen.id}`,
      role: 'user',
      timestamp: gen.timestamp,
      content: gen.prompt,
    });

    // Assistant message with the generation result
    messages.push({
      id: `msg-assistant-${gen.id}`,
      role: 'assistant',
      timestamp: gen.timestamp,
      generation: gen,
    });
  }

  return {
    version: 2,
    name: v1.name,
    created: v1.created,
    provider: v1.provider,
    sessions: [
      {
        id: sessionId,
        name: 'Imported Session',
        created: v1.created,
        updated: now,
        messages,
        settings: {
          style: v1.settings.defaultStyle,
          aspectRatio: v1.settings.defaultAspectRatio || '1:1',
        },
      },
    ],
    activeSessionId: sessionId,
    settings: v1.settings,
  };
}

/**
 * Create a new empty v2 project
 */
export function createEmptyProjectV2(name: string): ImageProjectV2 {
  const now = new Date().toISOString();
  const sessionId = `session-${Date.now()}`;

  return {
    version: 2,
    name,
    created: now,
    provider: 'gemini',
    sessions: [
      {
        id: sessionId,
        name: 'New Session',
        created: now,
        updated: now,
        messages: [],
        settings: {
          style: 'sketch',
          aspectRatio: '1:1',
        },
      },
    ],
    activeSessionId: sessionId,
    settings: {
      defaultStyle: 'sketch',
      variationsPerPrompt: 3,
      defaultAspectRatio: '1:1',
    },
  };
}

/**
 * A message in the conversation history for multi-turn generation
 */
export interface ConversationMessage {
  /** Role of the message sender */
  role: 'user' | 'model';
  /** Text content (for user messages or model descriptions) */
  text?: string;
  /** Image data as base64 (for model responses with images) */
  imageBase64?: string;
  /** MIME type of the image */
  imageMimeType?: string;
  /** Thought signature for context preservation */
  thoughtSignature?: string;
}

/**
 * Request to generate an image
 */
export interface GenerationRequest {
  /** The prompt describing the image */
  prompt: string;
  /** Style preset */
  style?: ImageStyle;
  /** Aspect ratio */
  aspectRatio?: AspectRatio;
  /** Number of variations to generate */
  numVariations?: number;
  /** Specific seed for reproducibility */
  seed?: number;
  /** Provider-specific options */
  providerOptions?: Record<string, unknown>;

  // Multi-turn conversation support
  /** Previous conversation history for iterative refinement */
  conversationHistory?: ConversationMessage[];
}

/**
 * Result from image generation
 */
export interface GenerationResult {
  /** Array of generated images */
  images: GeneratedImage[];
  /** Metadata about the generation */
  metadata: {
    /** Provider ID */
    provider: string;
    /** Model name/version */
    model: string;
    /** Generation timestamp */
    timestamp: string;
  };
  /** Thought signature for context preservation in multi-turn conversations */
  thoughtSignature?: string;
  /** Text description from the model (if any) */
  description?: string;
}

/**
 * Capabilities exposed by an image provider
 */
export interface ProviderCapabilities {
  /** Available style options */
  styles: ImageStyle[];
  /** Whether the provider supports generating variations */
  supportsVariations: boolean;
  /** Whether the provider supports inpainting */
  supportsInpainting: boolean;
  /** Maximum images per request */
  maxImagesPerRequest: number;
  /** Supported aspect ratios */
  supportedAspectRatios: AspectRatio[];
  /** Whether the provider supports multi-turn conversations for iterative refinement */
  supportsConversation: boolean;
}

/**
 * Interface that all image providers must implement
 */
export interface ImageProvider {
  /** Unique provider identifier */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Provider capabilities */
  capabilities: ProviderCapabilities;
  /**
   * Generate images from a prompt
   */
  generateImage(request: GenerationRequest): Promise<GenerationResult>;
  /**
   * Check if the provider is configured and ready to use
   */
  isConfigured(): boolean;
}

/**
 * Style preset configuration
 */
export interface StylePreset {
  id: ImageStyle;
  label: string;
  description: string;
  /** Icon or emoji for the style */
  icon?: string;
}

/**
 * Available style presets
 */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'sketch',
    label: 'Sketch',
    description: 'Hand-drawn look, architecture diagrams',
    icon: '&#128393;',
  },
  {
    id: 'diagram',
    label: 'Diagram',
    description: 'Flowcharts, system diagrams',
    icon: '&#128200;',
  },
  {
    id: 'illustration',
    label: 'Illustration',
    description: 'Blog graphics, icons',
    icon: '&#127912;',
  },
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    description: 'Product shots, scenes',
    icon: '&#128247;',
  },
  {
    id: 'wireframe',
    label: 'Wireframe',
    description: 'UI mockups',
    icon: '&#128187;',
  },
];

/**
 * Aspect ratio configuration
 */
export interface AspectRatioOption {
  id: AspectRatio;
  label: string;
  width: number;
  height: number;
}

/**
 * Available aspect ratios
 */
export const ASPECT_RATIOS: AspectRatioOption[] = [
  { id: '1:1', label: '1:1 Square', width: 1024, height: 1024 },
  { id: '16:9', label: '16:9 Wide', width: 1920, height: 1080 },
  { id: '9:16', label: '9:16 Portrait', width: 1080, height: 1920 },
  { id: '4:3', label: '4:3 Standard', width: 1024, height: 768 },
  { id: '3:4', label: '3:4 Portrait', width: 768, height: 1024 },
];

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Available Gemini models for image generation
 */
export type GeminiImageModel =
  | 'gemini-2.5-flash-image'
  | 'gemini-3-pro-image-preview';

/**
 * Model configuration
 */
export interface ModelOption {
  id: GeminiImageModel;
  label: string;
  description: string;
  supportsConversation: boolean;
}

/**
 * Available models for image generation
 * See: https://ai.google.dev/gemini-api/docs/models
 */
export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash',
    description: 'Fast image generation, optimized for speed and efficiency',
    supportsConversation: true,
  },
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Gemini 3 Pro',
    description: 'Highest quality, supports 2K/4K output, advanced reasoning',
    supportsConversation: true,
  },
];

/**
 * Default model for new projects
 */
export const DEFAULT_MODEL: GeminiImageModel = 'gemini-2.5-flash-image';

/**
 * Reference image that can be passed to guide generation
 */
export interface ReferenceImage {
  /** Absolute file path to the image */
  filePath: string;
}

/**
 * API exposed by the editor for AI tool access
 */
export interface ImageProjectEditorAPI {
  getProject: () => ImageProject;
  updateProject: (updater: (prev: ImageProject) => ImageProject) => void;
  generate: (
    prompt: string,
    style: ImageStyle,
    aspectRatio: AspectRatio,
    variations: number,
    referenceImages?: ReferenceImage[]
  ) => Promise<void>;
}
