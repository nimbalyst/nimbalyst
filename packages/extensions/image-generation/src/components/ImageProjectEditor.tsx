/**
 * Image Project Editor
 *
 * Custom editor for .imgproj files that provides a session-based conversational
 * interface for iteratively refining generated images.
 *
 * File format: v1 (legacy flat list) or v2 (session-based conversations)
 * v1 projects are automatically migrated to v2 on save.
 */

import { useEffect, useRef, useCallback, useState, forwardRef } from 'react';
import { useEditorLifecycle, type EditorHostProps } from '@nimbalyst/extension-sdk';
import type {
  ImageProject,
  ImageProjectV2,
  ImageSession,
  SessionMessage,
  Generation,
  ImageStyle,
  AspectRatio,
  GeneratedImage,
  ConversationMessage,
} from '../types';
import {
  isProjectV1,
  isProjectV2,
  migrateProjectV1ToV2,
  createEmptyProjectV2,
} from '../types';
import { Gallery } from './Gallery';
import { BottomBar } from './BottomBar';
import { nanoBananaProvider } from '../providers/nanoBanana';

import { DEFAULT_MODEL, type GeminiImageModel, type ReferenceImage } from '../types';

// Storage keys (must match SettingsPanel)
const GOOGLE_AI_KEY_STORAGE_KEY = 'google_ai_api_key';
const SELECTED_MODEL_STORAGE_KEY = 'selected_model';

/**
 * Load an image file and return its base64 data
 */
async function loadImageAsBase64(imagePath: string): Promise<string> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI) {
    throw new Error('electronAPI not available');
  }

  // Read the file as base64
  const content = await electronAPI.invoke('extensions:read-file', imagePath);
  // The file is binary, we need to read it differently
  // For now, we'll use a fetch approach
  const response = await fetch(`file://${imagePath}`);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64Data = base64.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * API Key Missing Banner
 * Shows when no API key is configured, directs user to Settings
 */
function ApiKeyMissingBanner({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div className="px-4 py-3 bg-[rgba(245,158,11,0.1)] border-b border-nim-warning text-nim-warning flex items-center gap-2 text-[13px]">
      <span className="flex-1">
        Google AI API key not configured. Go to <strong>Settings &gt; Extensions &gt; Image Generation</strong> to add your API key.
      </span>
    </div>
  );
}

export const ImageProjectEditor = forwardRef<unknown, EditorHostProps>(
  function ImageProjectEditor({ host }, _ref) {
    const { filePath } = host;

    // Project state - always stored as v2 internally
    const projectRef = useRef<ImageProjectV2 | null>(null);
    const [project, setProject] = useState<ImageProjectV2 | null>(null);

    // Currently active session
    const [activeSession, setActiveSession] = useState<ImageSession | null>(null);

    // Generation in progress
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationError, setGenerationError] = useState<string | null>(null);

    // API key state
    const [apiKeyConfigured, setApiKeyConfigured] = useState(false);

    // Load API key and model from extension storage on mount
    useEffect(() => {
      const loadSettings = async () => {
        try {
          // Load API key
          const apiKey = await host.storage.getSecret(GOOGLE_AI_KEY_STORAGE_KEY);
          if (apiKey) {
            nanoBananaProvider.setApiKey(apiKey);
            setApiKeyConfigured(true);
            console.log('[ImageGen] API key loaded from storage');
          } else {
            console.log('[ImageGen] No API key configured');
          }

          // Load selected model
          const storedModel = await host.storage.get(SELECTED_MODEL_STORAGE_KEY);
          if (storedModel && typeof storedModel === 'string') {
            nanoBananaProvider.setModel(storedModel as GeminiImageModel);
            console.log('[ImageGen] Model loaded from storage:', storedModel);
          } else {
            nanoBananaProvider.setModel(DEFAULT_MODEL);
            console.log('[ImageGen] Using default model:', DEFAULT_MODEL);
          }
        } catch (error) {
          console.error('[ImageGen] Failed to load settings:', error);
        }
      };
      loadSettings();
    }, [host.storage]);

    /**
     * Parse loaded content and migrate to v2 if needed
     */
    const parseAndMigrateProject = (content: string): ImageProjectV2 => {
      if (!content || content.trim() === '') {
        return createEmptyProjectV2('New Image Project');
      }

      const parsed = JSON.parse(content) as ImageProject;

      // Migrate v1 to v2
      if (isProjectV1(parsed)) {
        console.log('[ImageGen] Migrating v1 project to v2 format');
        return migrateProjectV1ToV2(parsed);
      }

      // Already v2
      if (isProjectV2(parsed)) {
        return parsed;
      }

      // Unknown format, create new
      console.warn('[ImageGen] Unknown project format, creating new');
      return createEmptyProjectV2('New Image Project');
    };

    // useEditorLifecycle handles: loading, saving, echo detection, file changes, theme
    const { markDirty, isLoading, error: loadError, theme: hostTheme } = useEditorLifecycle<ImageProjectV2>(host, {
      parse: (raw: string): ImageProjectV2 => parseAndMigrateProject(raw),
      serialize: (data: ImageProjectV2): string => JSON.stringify(data, null, 2),

      applyContent: (data: ImageProjectV2) => {
        projectRef.current = data;
        setProject(data);

        // Set/update active session
        const activeSessionId = data.activeSessionId || data.sessions[0]?.id;
        const session = data.sessions.find((s) => s.id === activeSessionId) || data.sessions[0];
        setActiveSession(session || null);
      },

      getCurrentContent: () => projectRef.current!,
    });

    const theme = (hostTheme === 'dark' || hostTheme === 'crystal-dark') ? 'dark' : 'light';

    // Update project and mark dirty
    const updateProject = useCallback(
      (updater: (prev: ImageProjectV2) => ImageProjectV2) => {
        setProject((prev) => {
          if (!prev) return prev;
          const updated = updater(prev);
          projectRef.current = updated;
          return updated;
        });
        markDirty();
      },
      [markDirty]
    );

    // Update active session and sync to project
    const updateActiveSession = useCallback(
      (updater: (prev: ImageSession) => ImageSession) => {
        if (!activeSession) return;

        const updated = updater(activeSession);
        setActiveSession(updated);

        // Also update in project
        updateProject((prev) => ({
          ...prev,
          sessions: prev.sessions.map((s) => (s.id === updated.id ? updated : s)),
        }));
      },
      [activeSession, updateProject]
    );

    // Create a new session
    const createNewSession = useCallback(
      (name?: string) => {
        const now = new Date().toISOString();
        const newSession: ImageSession = {
          id: `session-${Date.now()}`,
          name: name || 'New Session',
          created: now,
          updated: now,
          messages: [],
          settings: {
            style: project?.settings.defaultStyle || 'sketch',
            aspectRatio: project?.settings.defaultAspectRatio || '1:1',
          },
        };

        updateProject((prev) => ({
          ...prev,
          sessions: [...prev.sessions, newSession],
          activeSessionId: newSession.id,
        }));

        setActiveSession(newSession);
        return newSession;
      },
      [project, updateProject]
    );

    // Switch to a different session
    const switchSession = useCallback(
      (sessionId: string) => {
        if (!project) return;
        const session = project.sessions.find((s) => s.id === sessionId);
        if (session) {
          setActiveSession(session);
          updateProject((prev) => ({
            ...prev,
            activeSessionId: sessionId,
          }));
        }
      },
      [project, updateProject]
    );

    // Get the images folder path
    const getImagesFolderPath = useCallback(() => {
      return filePath.replace('.imgproj', '.imgproj.images');
    }, [filePath]);

    // Save image to disk
    const saveImageToDisk = useCallback(
      async (filename: string, base64Data: string): Promise<void> => {
        const imagesFolder = getImagesFolderPath();
        const imagePath = `${imagesFolder}/${filename}`;

        // Use the electronAPI to write binary data
        const electronAPI = (window as any).electronAPI;
        if (electronAPI) {
          await electronAPI.invoke('extensions:write-binary', imagePath, base64Data);
          console.log('[ImageGen] Saved image:', imagePath);
        } else {
          throw new Error('electronAPI not available');
        }
      },
      [getImagesFolderPath]
    );

    /**
     * Build conversation history from session messages for API call
     * Loads images from disk and converts to base64
     */
    const buildConversationHistory = useCallback(
      async (session: ImageSession): Promise<ConversationMessage[]> => {
        const history: ConversationMessage[] = [];
        const imagesFolder = getImagesFolderPath();

        for (const msg of session.messages) {
          if (msg.role === 'user' && msg.content) {
            history.push({
              role: 'user',
              text: msg.content,
            });
          } else if (msg.role === 'assistant') {
            // For assistant messages, include image if available, otherwise text
            if (msg.generation && msg.generation.results.length > 0) {
              // Load the first image as base64 for context
              const firstImage = msg.generation.results[0];
              try {
                const base64Data = await loadImageAsBase64(`${imagesFolder}/${firstImage.file}`);
                history.push({
                  role: 'model',
                  imageBase64: base64Data,
                  imageMimeType: 'image/png',
                  thoughtSignature: msg.thoughtSignature,
                });
              } catch (error) {
                console.warn('[ImageGen] Failed to load image for history:', error);
                // Fall back to text description
                if (msg.description) {
                  history.push({
                    role: 'model',
                    text: msg.description,
                    thoughtSignature: msg.thoughtSignature,
                  });
                }
              }
            } else if (msg.description) {
              // Text-only response (no image generated)
              history.push({
                role: 'model',
                text: msg.description,
                thoughtSignature: msg.thoughtSignature,
              });
            }
          }
        }

        return history;
      },
      [getImagesFolderPath]
    );

    // Handle generation request (session-aware)
    const handleGenerate = useCallback(
      async (
        prompt: string,
        style: ImageStyle,
        aspectRatio: AspectRatio,
        variations: number,
        referenceImages?: ReferenceImage[]
      ) => {
        if (!project || !activeSession || isGenerating) return;

        // Check if API key is configured
        if (!nanoBananaProvider.isConfigured()) {
          setGenerationError(
            'Google AI API key not configured. Please set your API key in the extension settings.'
          );
          return;
        }

        setIsGenerating(true);
        setGenerationError(null);

        try {
          const now = new Date().toISOString();
          // Debug logging - uncomment if needed
          // console.log('[ImageGen] Starting generation:', { prompt, style, aspectRatio, variations, referenceImages: referenceImages?.length || 0 });

          // Build conversation history if this is not the first message
          let conversationHistory: ConversationMessage[] | undefined;
          if (activeSession.messages.length > 0) {
            console.log('[ImageGen] Building conversation history from', activeSession.messages.length, 'messages');
            conversationHistory = await buildConversationHistory(activeSession);
          }

          // Load reference images as base64 and add to conversation history
          if (referenceImages && referenceImages.length > 0) {
            // Debug logging - uncomment if needed
            // console.log('[ImageGen] Loading', referenceImages.length, 'reference images');
            if (!conversationHistory) {
              conversationHistory = [];
            }
            for (const ref of referenceImages) {
              try {
                const base64Data = await loadImageAsBase64(ref.filePath);
                // Determine MIME type from extension
                const ext = ref.filePath.toLowerCase().split('.').pop();
                const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                 ext === 'gif' ? 'image/gif' :
                                 ext === 'webp' ? 'image/webp' : 'image/png';
                conversationHistory.push({
                  role: 'user',
                  text: 'Here is a reference image to use:',
                  imageBase64: base64Data,
                  imageMimeType: mimeType,
                });
              } catch (error) {
                console.warn('[ImageGen] Failed to load reference image:', ref.filePath, error);
              }
            }
          }

          // Call the image generation API
          const result = await nanoBananaProvider.generateImage({
            prompt,
            style,
            aspectRatio,
            numVariations: conversationHistory ? 1 : variations, // Only 1 for multi-turn
            conversationHistory,
          });

          console.log('[ImageGen] Result:', result.images.length, 'images, description:', result.description?.slice(0, 50));

          // Save images to disk and strip the base64 data
          const savedImages: GeneratedImage[] = [];
          for (const image of result.images) {
            const imageWithData = image as GeneratedImage & { _base64Data?: string };
            if (imageWithData._base64Data) {
              await saveImageToDisk(image.file, imageWithData._base64Data);
              savedImages.push({
                file: image.file,
                seed: image.seed,
                width: image.width,
                height: image.height,
              });
            }
          }

          // Create user message
          const userMessage: SessionMessage = {
            id: `msg-user-${Date.now()}`,
            role: 'user',
            timestamp: now,
            content: prompt,
          };

          // Create assistant message
          // May have images, text only, or both
          const assistantMessage: SessionMessage = {
            id: `msg-assistant-${Date.now()}`,
            role: 'assistant',
            timestamp: now,
            description: result.description,
            thoughtSignature: result.thoughtSignature,
          };

          // Only include generation if there are images
          if (savedImages.length > 0) {
            assistantMessage.generation = {
              id: `gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              prompt,
              style,
              aspectRatio,
              parameters: {},
              timestamp: now,
              results: savedImages,
            };
          }

          // Add messages to session
          updateActiveSession((prev) => ({
            ...prev,
            updated: now,
            messages: [...prev.messages, userMessage, assistantMessage],
          }));

          console.log('[ImageGen] Complete:', savedImages.length, 'images,', result.description ? 'with text' : 'no text');
        } catch (error) {
          console.error('[ImageGen] Generation failed:', error);
          setGenerationError(error instanceof Error ? error.message : 'Generation failed');
        } finally {
          setIsGenerating(false);
        }
      },
      [project, activeSession, isGenerating, updateActiveSession, saveImageToDisk, buildConversationHistory]
    );

    // Handle edit & retry from gallery
    const handleEditPrompt = useCallback(
      (generation: Generation) => {
        // This will be handled by passing the prompt to the bottom bar
        // For now, just log
        console.log('[ImageGen] Edit prompt:', generation.prompt);
      },
      []
    );

    // Register editor API for AI tool access via the central registry
    useEffect(() => {
      if (project) {
        const api = {
          getProject: () => project,
          updateProject: updateProject as any,
          generate: handleGenerate,
        };
        host.registerEditorAPI(api);
        return () => {
          host.registerEditorAPI(null);
        };
      }
    }, [filePath, project, updateProject, handleGenerate]);

    // Show loading state
    if (isLoading) {
      return (
        <div
          className="image-project-editor w-full h-full flex items-center justify-center"
          data-theme={theme}
        >
          <div className="text-nim-muted">Loading project...</div>
        </div>
      );
    }

    // Show error state
    if (loadError) {
      return (
        <div
          className="image-project-editor w-full h-full flex items-center justify-center"
          data-theme={theme}
        >
          <div className="text-nim-error">Failed to load: {loadError.message}</div>
        </div>
      );
    }

    if (!project) {
      return null;
    }

    // Get messages for the active session (for Gallery)
    const sessionMessages = activeSession?.messages || [];

    return (
      <div
        className="image-project-editor w-full h-full flex flex-col overflow-hidden"
        data-theme={theme}
      >
        {/* API Key Missing Banner */}
        {!apiKeyConfigured && (
          <ApiKeyMissingBanner theme={theme} />
        )}

        {/* Error Banner */}
        {generationError && (
          <div className="px-4 py-3 bg-[#3f1d1d] border-b border-nim-error text-nim-error flex items-center gap-2">
            <span className="flex-1">{generationError}</span>
            <button
              onClick={() => setGenerationError(null)}
              className="bg-transparent border-none text-nim-error cursor-pointer px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Session header with session selector */}
        {project.sessions.length > 1 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-nim-secondary border-b border-nim text-sm">
            <span className="text-nim-muted">Session:</span>
            <select
              value={activeSession?.id || ''}
              onChange={(e) => switchSession(e.target.value)}
              className="bg-nim border border-nim rounded px-2 py-1 text-nim text-sm"
            >
              {project.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name || 'Untitled Session'}
                </option>
              ))}
            </select>
            <button
              onClick={() => createNewSession()}
              className="ml-2 px-2 py-1 bg-nim-hover border border-nim rounded text-nim text-xs cursor-pointer"
            >
              + New Session
            </button>
          </div>
        )}

        <Gallery
          messages={sessionMessages}
          imagesBasePath={filePath.replace('.imgproj', '.imgproj.images')}
          onEditPrompt={handleEditPrompt}
          theme={theme}
        />
        <BottomBar
          defaultStyle={activeSession?.settings.style || project.settings.defaultStyle}
          defaultAspectRatio={activeSession?.settings.aspectRatio || project.settings.defaultAspectRatio || '1:1'}
          defaultVariations={project.settings.variationsPerPrompt}
          isGenerating={isGenerating}
          onGenerate={handleGenerate}
          theme={theme}
        />
      </div>
    );
  }
);
