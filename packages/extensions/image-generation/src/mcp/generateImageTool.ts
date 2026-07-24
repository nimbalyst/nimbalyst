/**
 * Generate Image AI Tool
 *
 * MCP tool that allows the coding agent to generate images.
 * Supports session-based iterative refinement - subsequent calls with the same
 * project file will build on previous generations in the conversation.
 */

import type { ImageStyle, AspectRatio, ImageProjectEditorAPI, ReferenceImage } from '../types';

/**
 * AI tool definition for generate_image
 */
export const generateImageTool = {
  name: 'generate_image',
  description: `Generate an image using AI. Can create sketches, diagrams, photorealistic images, and more.

Use this tool when the user asks you to create or generate:
- Architecture diagrams
- System flow diagrams
- UI wireframes
- Sketches or illustrations
- Any visual content

The image will be added to the active image generation project (.imgproj file).
If no project is open, you should first create one.

**Session-based refinement**: Each project maintains a conversation session. Subsequent
calls will use the previous images as context, allowing you to iteratively refine:
- First call: "Create a microservices architecture diagram"
- Second call: "Make the boxes rounder and add colors"
- Third call: "Add labels to each service"

The model will see previous images and build upon them.

**Reference images**: You can pass reference images to guide the generation. This is useful
for incorporating existing logos, branding, or visual elements into the generated image.`,
  scope: 'global' as const, // Available even when no .imgproj file is open
  parameters: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string' as const,
        description:
          'Detailed description of the image to generate, or a refinement instruction if building on previous images. Be specific about layout, elements, style, and any text that should appear.',
      },
      style: {
        type: 'string' as const,
        enum: ['sketch', 'diagram', 'illustration', 'photorealistic', 'wireframe'],
        description: `Visual style for the generated image:
- sketch: Hand-drawn look, good for architecture diagrams
- diagram: Clean technical flowcharts and system diagrams
- illustration: Colorful graphics and icons
- photorealistic: Realistic product shots and scenes
- wireframe: UI mockups and layouts`,
      },
      aspectRatio: {
        type: 'string' as const,
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: 'Aspect ratio for the image (default: 1:1)',
      },
      variations: {
        type: 'number' as const,
        description: 'Number of variations to generate (1-4, default: 3). Note: When refining a previous image, only 1 variation is generated.',
      },
      referenceImages: {
        type: 'array' as const,
        description:
          'Optional: Array of reference images to guide the generation. Each item should have a filePath property with the absolute path to an image file (PNG, JPG, etc.). Use this to incorporate existing logos, icons, or visual elements.',
        items: {
          type: 'object' as const,
          properties: {
            filePath: {
              type: 'string' as const,
              description: 'Absolute file path to the reference image',
            },
          },
          required: ['filePath'],
        },
      },
      projectFile: {
        type: 'string' as const,
        description:
          'Optional: path to .imgproj file to add this generation to. If not provided, uses the active editor.',
      },
    },
    required: ['prompt'],
  },
  handler: async (
    params: {
      prompt: string;
      style?: ImageStyle;
      aspectRatio?: AspectRatio;
      variations?: number;
      referenceImages?: ReferenceImage[];
      projectFile?: string;
    },
    context: { activeFilePath?: string; editorAPI?: unknown }
  ) => {
    const {
      prompt,
      style = 'sketch',
      aspectRatio = '1:1',
      variations = 3,
      referenceImages,
      projectFile,
    } = params;

    // Get the editor API from the central registry
    const api = context.editorAPI as ImageProjectEditorAPI | undefined;

    if (!api) {
      return {
        success: false,
        error:
          'No active image generation project found. Please open or create an .imgproj file first.',
      };
    }

    try {
      // Trigger generation through the editor
      await api.generate(
        prompt,
        style,
        aspectRatio,
        Math.min(4, Math.max(1, variations)),
        referenceImages
      );

      return {
        success: true,
        message: `Image generation started with prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
        data: {
          prompt,
          style,
          aspectRatio,
          variations,
          referenceImages: referenceImages?.length || 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
