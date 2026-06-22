/**
 * AI Tools for Excalidraw
 *
 * Provides Claude with tools to view and edit Excalidraw diagrams.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';

/**
 * Get the Excalidraw editor API from the tool context.
 * Uses the central EditorHost registry (context.editorAPI) populated by the bridge.
 */
function getEditorAPI(context: { editorAPI?: unknown }): ExcalidrawImperativeAPI | null {
  return (context.editorAPI as ExcalidrawImperativeAPI) ?? null;
}

/** Build a consistent error result when no editor API is available. */
function noEditorError(context: { activeFilePath?: string }): { success: false; error: string } {
  const path = context.activeFilePath;
  if (!path) {
    return {
      success: false,
      error: 'No active Excalidraw editor found. Please provide a filePath to a .excalidraw file.',
    };
  }
  return {
    success: false,
    error: `Could not connect to Excalidraw editor for ${path}. ` +
      'The file may exist but the editor failed to initialize. ' +
      'Try again — if the file does not exist yet, create it first with the Write tool.',
  };
}
import { LayoutEngine } from './layout/LayoutEngine';
import { createFrame } from './utils/elementFactory';

// Helper to normalize color names to Excalidraw palette
function normalizeColor(color?: string): string | undefined {
  if (!color) return undefined;
  const colorMap: Record<string, string> = {
    red: '#ffc9c9',
    green: '#b2f2bb',
    blue: '#a5d8ff',
    yellow: '#ffec99',
    orange: '#ffd8a8',
    purple: '#e599f7',
    pink: '#ffc0cb',
    gray: '#e9ecef',
    grey: '#e9ecef',
  };
  return colorMap[color.toLowerCase()] || color;
}

// Expose for testing
if (typeof window !== 'undefined') {
  (window as any).__excalidraw_parseMermaidToExcalidraw = parseMermaidToExcalidraw;
  (window as any).__excalidraw_convertToExcalidrawElements = convertToExcalidrawElements;
}

/**
 * Calculate the point on a rectangle's edge closest to a target point
 * Used to make arrows connect to element edges instead of centers
 */
function calculateEdgePoint(
  element: ExcalidrawElement,
  targetX: number,
  targetY: number,
  gap: number
): { x: number; y: number } {
  const centerX = element.x + (element.width || 0) / 2;
  const centerY = element.y + (element.height || 0) / 2;
  const halfWidth = (element.width || 0) / 2;
  const halfHeight = (element.height || 0) / 2;

  // Vector from center to target
  const dx = targetX - centerX;
  const dy = targetY - centerY;

  if (dx === 0 && dy === 0) {
    // Target is at center, default to right edge
    return { x: centerX + halfWidth + gap, y: centerY };
  }

  // Calculate intersection with rectangle edges
  // We need to find where the line from center to target intersects the rectangle
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let edgeX: number;
  let edgeY: number;

  // Determine which edge the line intersects
  if (absDx * halfHeight > absDy * halfWidth) {
    // Intersects left or right edge
    if (dx > 0) {
      // Right edge
      edgeX = centerX + halfWidth + gap;
      edgeY = centerY + (dy / dx) * halfWidth;
    } else {
      // Left edge
      edgeX = centerX - halfWidth - gap;
      edgeY = centerY - (dy / dx) * halfWidth;
    }
  } else {
    // Intersects top or bottom edge
    if (dy > 0) {
      // Bottom edge
      edgeY = centerY + halfHeight + gap;
      edgeX = centerX + (dx / dy) * halfHeight;
    } else {
      // Top edge
      edgeY = centerY - halfHeight - gap;
      edgeX = centerX - (dx / dy) * halfHeight;
    }
  }

  return { x: edgeX, y: edgeY };
}

/**
 * Helper to get an element by its label text
 */
function getElementByLabel(elements: readonly ExcalidrawElement[], label: string): ExcalidrawElement | undefined {
  return elements.find((el) => {
    if ('text' in el && el.text === label) return true;
    if ('label' in el && (el as any).label?.text === label) return true;
    return false;
  });
}

/**
 * AI tool definitions (exported as array)
 */
export const aiTools = [
  {
    name: 'get_elements',
    scope: 'global' as const,
    readOnly: true,
    description: 'Get list of diagram elements with labels and group membership. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (_params: Record<string, never>, context: { activeFilePath?: string; editorAPI?: unknown }) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const sceneElements = api.getSceneElements();

      // Extract labeled elements
      const elements = sceneElements
        .filter((el) => {
          if ('text' in el && el.text) return true;
          if ('label' in el && (el as any).label?.text) return true;
          return false;
        })
        .map((el) => {
          const label = ('text' in el && el.text) || ('label' in el && (el as any).label?.text) || '';

          return {
            id: el.id,
            type: el.type,
            label,
          };
        });

      return {
        success: true,
        data: { elements },
      };
    },
  },

  {
    name: 'add_rectangle',
    scope: 'global' as const,
    description: 'Add a labeled rectangle to the diagram. Rectangles are rounded by default. Use x,y for explicit positioning, or nearElement for relative placement. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string' as const,
          description: 'Text label for the rectangle',
        },
        x: {
          type: 'number' as const,
          description: 'X position (left edge). If not provided, auto-positions.',
        },
        y: {
          type: 'number' as const,
          description: 'Y position (top edge). If not provided, auto-positions.',
        },
        width: {
          type: 'number' as const,
          description: 'Width of the rectangle (default: 150)',
        },
        height: {
          type: 'number' as const,
          description: 'Height of the rectangle (default: 80)',
        },
        nearElement: {
          type: 'string' as const,
          description: 'Optional element label to place near (ignored if x,y provided)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color. PREFER Excalidraw default palette for best visual consistency: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple), #ffc0cb (pink). When user says "red", use #ffc9c9 not #ff0000.',
        },
        strokeColor: {
          type: 'string' as const,
          description: 'Border color (hex code or color name)',
        },
        rounded: {
          type: 'boolean' as const,
          description: 'Whether to use rounded corners (default: true)',
        },
      },
      required: ['label'],
    },
    handler: async (
      params: {
        label: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        nearElement?: string;
        color?: string;
        strokeColor?: string;
        rounded?: boolean;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const { label, nearElement, color, strokeColor, rounded = true } = params;
      const currentElements = api.getSceneElements() || [];

      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 150;
      const height = params.height || 80;

      let position: { x: number; y: number };

      // Use explicit coordinates if provided
      if (params.x !== undefined && params.y !== undefined) {
        position = { x: params.x, y: params.y };
      } else if (nearElement) {
        const nearEl = getElementByLabel(currentElements, nearElement);
        if (nearEl) {
          position = engine.calculateNearPosition(nearEl.id, width, height);
        } else {
          position = engine.calculateDefaultPosition(width, height);
        }
      } else {
        position = engine.calculateDefaultPosition(width, height);
      }

      // Use skeleton format with convertToExcalidrawElements for proper text binding
      const rectSkeleton: any = {
        type: 'rectangle',
        x: position.x,
        y: position.y,
        width,
        height,
        backgroundColor: normalizeColor(color) || 'transparent',
        strokeColor: normalizeColor(strokeColor) || '#1e1e1e',
        roundness: rounded ? { type: 3 } : null,
        label: {
          text: label,
        },
      };

      const newElements = convertToExcalidrawElements([rectSkeleton]);

      // Update scene with new elements
      api.updateScene({
        elements: [...currentElements, ...newElements],
      });

      // Find the rectangle element (not the text)
      const rectElement = newElements.find(el => el.type === 'rectangle');
      return { success: true, data: { id: rectElement?.id, x: position.x, y: position.y } };
    },
  },

  {
    name: 'add_arrow',
    scope: 'global' as const,
    description: 'Add an arrow connecting two elements. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string' as const,
          description: 'Label of the source element',
        },
        to: {
          type: 'string' as const,
          description: 'Label of the target element',
        },
        label: {
          type: 'string' as const,
          description: 'Optional label for the arrow',
        },
      },
      required: ['from', 'to'],
    },
    handler: async (
      params: {
        from: string;
        to: string;
        label?: string;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();
      const fromEl = getElementByLabel(currentElements, params.from);
      const toEl = getElementByLabel(currentElements, params.to);

      if (!fromEl || !toEl) {
        return {
          success: false,
          error: `Could not find elements: ${!fromEl ? params.from : ''} ${!toEl ? params.to : ''}`,
        };
      }

      // Get the container element if this is a text element bound to a rectangle
      let fromContainerId = fromEl.id;
      let toContainerId = toEl.id;

      if ('containerId' in fromEl && fromEl.containerId) {
        fromContainerId = fromEl.containerId as string;
      }
      if ('containerId' in toEl && toEl.containerId) {
        toContainerId = toEl.containerId as string;
      }

      // Get the actual container elements
      const fromContainer = currentElements.find(el => el.id === fromContainerId) || fromEl;
      const toContainer = currentElements.find(el => el.id === toContainerId) || toEl;

      // Calculate center points
      const fromCenterX = fromContainer.x + (fromContainer.width || 0) / 2;
      const fromCenterY = fromContainer.y + (fromContainer.height || 0) / 2;
      const toCenterX = toContainer.x + (toContainer.width || 0) / 2;
      const toCenterY = toContainer.y + (toContainer.height || 0) / 2;

      // Calculate edge intersection points (where arrow should start/end)
      const gap = 8;
      const fromEdge = calculateEdgePoint(fromContainer, toCenterX, toCenterY, gap);
      const toEdge = calculateEdgePoint(toContainer, fromCenterX, fromCenterY, gap);

      // Generate arrow ID
      const arrowId = `arrow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Create arrow element with edge-to-edge points
      const arrow: any = {
        id: arrowId,
        type: 'arrow',
        x: fromEdge.x,
        y: fromEdge.y,
        width: toEdge.x - fromEdge.x,
        height: toEdge.y - fromEdge.y,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 2 },
        seed: Math.floor(Math.random() * 1000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 1000000),
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        points: [
          [0, 0],
          [toEdge.x - fromEdge.x, toEdge.y - fromEdge.y],
        ],
        lastCommittedPoint: null,
        startBinding: {
          elementId: fromContainerId,
          focus: 0,
          gap,
        },
        endBinding: {
          elementId: toContainerId,
          focus: 0,
          gap,
        },
        startArrowhead: null,
        endArrowhead: 'arrow',
      };

      // Update the source and target elements to include arrow in boundElements
      const updatedElements = currentElements.map(el => {
        if (el.id === fromContainerId || el.id === toContainerId) {
          const existingBound = (el as any).boundElements || [];
          return {
            ...el,
            boundElements: [...existingBound, { id: arrowId, type: 'arrow' }],
          };
        }
        return el;
      });

      api.updateScene({
        elements: [...updatedElements, arrow],
      });

      return { success: true, data: { id: arrowId } };
    },
  },

  {
    name: 'update_element',
    scope: 'global' as const,
    description: 'Update text, color, or style of existing element. Can look up by ID or label. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string' as const,
          description: 'Element ID to update (use this if you have the ID from get_elements)',
        },
        label: {
          type: 'string' as const,
          description: 'Current label of the element to update (alternative to id)',
        },
        newLabel: {
          type: 'string' as const,
          description: 'New label text',
        },
        color: {
          type: 'string' as const,
          description: 'New fill color (hex code or color name)',
        },
        strokeColor: {
          type: 'string' as const,
          description: 'New border color (hex code or color name)',
        },
      },
    },
    handler: async (
      params: {
        id?: string;
        label?: string;
        newLabel?: string;
        color?: string;
        strokeColor?: string;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (!params.id && !params.label) {
        return {
          success: false,
          error: 'Must provide either id or label',
        };
      }

      const currentElements = api.getSceneElements();

      // Find element by ID or label
      let textElement: ExcalidrawElement | undefined;
      if (params.id) {
        textElement = currentElements.find(el => el.id === params.id);
      } else if (params.label) {
        textElement = getElementByLabel(currentElements, params.label);
      }

      if (!textElement) {
        return {
          success: false,
          error: `Element not found: ${params.label}`,
        };
      }

      // Helper to normalize colors to Excalidraw palette
      const normalizeColor = (color?: string): string | undefined => {
        if (!color) return undefined;
        const colorMap: Record<string, string> = {
          red: '#ffc9c9', green: '#b2f2bb', blue: '#a5d8ff', yellow: '#ffec99',
          orange: '#ffd8a8', purple: '#e599f7', pink: '#ffc0cb', gray: '#e9ecef', grey: '#e9ecef',
        };
        return colorMap[color.toLowerCase()] || color;
      };

      // Find the container (rectangle) if this is a text element bound to one
      let containerElement: ExcalidrawElement | undefined;
      if ('containerId' in textElement && textElement.containerId) {
        containerElement = currentElements.find(el => el.id === textElement.containerId);
      }

      // Prepare updates for text element
      const textUpdates: any = {};
      if (params.newLabel && 'text' in textElement) {
        textUpdates.text = params.newLabel;
      }

      // Prepare updates for container (for color changes)
      const containerUpdates: any = {};
      if (params.color !== undefined) {
        containerUpdates.backgroundColor = normalizeColor(params.color);
      }
      if (params.strokeColor !== undefined) {
        containerUpdates.strokeColor = normalizeColor(params.strokeColor);
      }

      // Apply updates
      const updatedElements = currentElements.map((el) => {
        if (el.id === textElement.id && Object.keys(textUpdates).length > 0) {
          return { ...el, ...textUpdates };
        }
        if (containerElement && el.id === containerElement.id && Object.keys(containerUpdates).length > 0) {
          return { ...el, ...containerUpdates };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true };
    },
  },

  {
    name: 'remove_element',
    scope: 'global' as const,
    description: 'Remove an element by ID or label. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string' as const,
          description: 'Element ID to remove (use this if you have the ID from get_elements)',
        },
        label: {
          type: 'string' as const,
          description: 'Label of the element to remove (alternative to id)',
        },
      },
    },
    handler: async (
      params: { id?: string; label?: string },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (!params.id && !params.label) {
        return {
          success: false,
          error: 'Must provide either id or label',
        };
      }

      const currentElements = api.getSceneElements();

      // Find element by ID or label
      let element: ExcalidrawElement | undefined;
      if (params.id) {
        element = currentElements.find(el => el.id === params.id);
      } else if (params.label) {
        element = getElementByLabel(currentElements, params.label);
      }

      if (!element) {
        return {
          success: false,
          error: `Element not found`,
        };
      }

      // Remove both the element and its container (if it's a text element)
      let idsToRemove = [element.id];
      if ('containerId' in element && element.containerId) {
        idsToRemove.push(element.containerId as string);
      }

      const updatedElements = currentElements.filter((el) => !idsToRemove.includes(el.id));

      api.updateScene({ elements: updatedElements });

      return { success: true };
    },
  },

  // TODO: The relayout tool does a terrible job - it scatters elements randomly
  // instead of creating a clean layout. Needs proper graph layout algorithm implementation.
  // Commenting out until fixed.
  // {
  //   name: 'relayout',
  //   description: 'Re-run layout engine on entire diagram',
  //   parameters: {
  //     type: 'object' as const,
  //     properties: {
  //       algorithm: {
  //         type: 'string' as const,
  //         enum: ['hierarchical', 'force-directed', 'grid'],
  //         description: 'Layout algorithm to use',
  //       },
  //       direction: {
  //         type: 'string' as const,
  //         enum: ['TB', 'LR', 'BT', 'RL'],
  //         description: 'Direction for hierarchical layout',
  //       },
  //     },
  //   },
  //   handler: async (
  //     params: {
  //       algorithm?: string;
  //       direction?: string;
  //     },
  //     context: { activeFilePath?: string; editorAPI?: unknown }
  //   ) => {
  //     const api = getEditorAPI(context);
  //     if (!api) {
  //       return {
  //         success: false,
  //         error: 'No active Excalidraw editor found.',
  //       };
  //     }
  //
  //     const algorithm = (params.algorithm || 'hierarchical') as 'hierarchical' | 'force-directed' | 'grid';
  //     const direction = (params.direction || 'TB') as 'TB' | 'LR' | 'BT' | 'RL';
  //
  //     const currentElements = api.getSceneElements();
  //     const engine = new LayoutEngine();
  //     engine.addElements(currentElements);
  //
  //     const positions = engine.layout({
  //       algorithm,
  //       direction,
  //     });
  //
  //     const updatedElements = currentElements.map((el) => {
  //       const pos = positions.get(el.id);
  //       return pos ? { ...el, x: pos.x, y: pos.y } : el;
  //     });
  //
  //     api.updateScene({ elements: updatedElements });
  //
  //     return { success: true };
  //   },
  // },

  {
    name: 'import_mermaid',
    scope: 'global' as const,
    description: 'Import a Mermaid diagram into Excalidraw. Use this to create complex architecture diagrams, flowcharts, and system designs. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        mermaid: {
          type: 'string' as const,
          description: 'Mermaid diagram syntax (e.g., "graph TD; A-->B; B-->C")',
        },
      },
      required: ['mermaid'],
    },
    handler: async (
      params: { mermaid: string },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      try {
        const { elements, files } = await parseMermaidToExcalidraw(params.mermaid, {
          themeVariables: { fontSize: '16px' },
        });

        // Convert skeleton elements to proper Excalidraw elements
        const excalidrawElements = convertToExcalidrawElements(elements);

        console.log('[import_mermaid] Got', elements.length, 'skeleton elements');
        console.log('[import_mermaid] Converted to', excalidrawElements.length, 'excalidraw elements');

        const currentElements = api.getSceneElements();
        console.log('[import_mermaid] Current scene has', currentElements.length, 'elements');

        // Add converted elements to the scene
        const newElements = [...currentElements, ...excalidrawElements];
        console.log('[import_mermaid] Updating scene with', newElements.length, 'total elements');

        // Register the image blob(s) Mermaid produced before adding the elements
        // that reference them. The rendered diagram is an image element whose
        // data lives in `files`; updateScene does not accept files, so without
        // addFiles the fileId resolves to nothing and the element renders as a
        // broken thumbnail (#428).
        const importedFiles = Object.values(files);
        if (importedFiles.length > 0) {
          api.addFiles(importedFiles);
        }

        api.updateScene({
          elements: newElements,
        });

        console.log('[import_mermaid] After updateScene, scene has', api.getSceneElements().length, 'elements');

        return {
          success: true,
          message: `Imported Mermaid diagram: ${elements.length} skeleton → ${excalidrawElements.length} elements`
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to parse Mermaid: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  {
    name: 'clear_all',
    scope: 'global' as const,
    description: 'Remove all elements from the diagram. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      params: Record<string, never>,
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      api.updateScene({ elements: [] });

      return {
        success: true,
        message: 'Cleared all elements from the diagram'
      };
    },
  },

  {
    name: 'add_frame',
    scope: 'global' as const,
    description: 'Add a frame (container with title) to group related elements. Frames have a title bar and can contain other elements. Use this to create visual sections like "Browser", "Services", "Database" in architecture diagrams. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          description: 'Title/name for the frame (appears at top)',
        },
        x: {
          type: 'number' as const,
          description: 'X position (left edge)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position (top edge)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of the frame (default: 400)',
        },
        height: {
          type: 'number' as const,
          description: 'Height of the frame (default: 300)',
        },
      },
      required: ['name'],
    },
    handler: async (
      params: {
        name: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 400;
      const height = params.height || 300;

      let x = params.x;
      let y = params.y;

      // If no position specified, find a good default position
      if (x === undefined || y === undefined) {
        const pos = engine.calculateDefaultPosition(width, height);
        x = x ?? pos.x;
        y = y ?? pos.y;
      }

      const frame = createFrame({
        x,
        y,
        width,
        height,
        name: params.name,
      });

      api.updateScene({
        elements: [...currentElements, frame],
      });

      return { success: true, data: { id: frame.id, x, y, width, height } };
    },
  },

  {
    name: 'add_row',
    scope: 'global' as const,
    description: 'Add multiple labeled rectangles arranged horizontally in a row. Great for creating groups of related items side by side. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels for each rectangle in the row',
        },
        x: {
          type: 'number' as const,
          description: 'X position of the first element (default: auto-positioned)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position of the row (default: auto-positioned)',
        },
        spacing: {
          type: 'number' as const,
          description: 'Space between elements (default: 20)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color for all rectangles. PREFER Excalidraw palette: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of each rectangle (default: 120)',
        },
        height: {
          type: 'number' as const,
          description: 'Height of each rectangle (default: 60)',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
        x?: number;
        y?: number;
        spacing?: number;
        color?: string;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 120;
      const height = params.height || 60;
      const spacing = params.spacing || 20;

      // Calculate starting position
      let startX = params.x;
      let startY = params.y;

      if (startX === undefined || startY === undefined) {
        const totalWidth = params.labels.length * width + (params.labels.length - 1) * spacing;
        const pos = engine.calculateDefaultPosition(totalWidth, height);
        startX = startX ?? pos.x;
        startY = startY ?? pos.y;
      }

      // Create skeleton array for all rectangles
      const skeletons: any[] = params.labels.map((label, index) => ({
        type: 'rectangle',
        x: startX! + index * (width + spacing),
        y: startY!,
        width,
        height,
        backgroundColor: normalizeColor(params.color) || 'transparent',
        strokeColor: '#1e1e1e',
        roundness: { type: 3 },
        label: {
          text: label,
        },
      }));

      const newElements = convertToExcalidrawElements(skeletons);
      const ids = newElements.filter(el => el.type === 'rectangle').map(el => el.id);

      api.updateScene({
        elements: [...currentElements, ...newElements],
      });

      return { success: true, data: { ids, count: params.labels.length } };
    },
  },

  {
    name: 'add_column',
    scope: 'global' as const,
    description: 'Add multiple labeled rectangles arranged vertically in a column. Great for creating stacked items or lists. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels for each rectangle in the column',
        },
        x: {
          type: 'number' as const,
          description: 'X position of the column (default: auto-positioned)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position of the first element (default: auto-positioned)',
        },
        spacing: {
          type: 'number' as const,
          description: 'Space between elements (default: 20)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color for all rectangles. PREFER Excalidraw palette: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of each rectangle (default: 120)',
        },
        height: {
          type: 'number' as const,
          description: 'Height of each rectangle (default: 60)',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
        x?: number;
        y?: number;
        spacing?: number;
        color?: string;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 120;
      const height = params.height || 60;
      const spacing = params.spacing || 20;

      // Calculate starting position
      let startX = params.x;
      let startY = params.y;

      if (startX === undefined || startY === undefined) {
        const totalHeight = params.labels.length * height + (params.labels.length - 1) * spacing;
        const pos = engine.calculateDefaultPosition(width, totalHeight);
        startX = startX ?? pos.x;
        startY = startY ?? pos.y;
      }

      // Create skeleton array for all rectangles
      const skeletons: any[] = params.labels.map((label, index) => ({
        type: 'rectangle',
        x: startX!,
        y: startY! + index * (height + spacing),
        width,
        height,
        backgroundColor: normalizeColor(params.color) || 'transparent',
        strokeColor: '#1e1e1e',
        roundness: { type: 3 },
        label: {
          text: label,
        },
      }));

      const newElements = convertToExcalidrawElements(skeletons);
      const ids = newElements.filter(el => el.type === 'rectangle').map(el => el.id);

      api.updateScene({
        elements: [...currentElements, ...newElements],
      });

      return { success: true, data: { ids, count: params.labels.length } };
    },
  },

  {
    name: 'align_elements',
    scope: 'global' as const,
    description: 'Align multiple elements by their labels. Use this to make elements line up neatly. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to align',
        },
        alignment: {
          type: 'string' as const,
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'],
          description: 'How to align the elements',
        },
      },
      required: ['labels', 'alignment'],
    },
    handler: async (
      params: {
        labels: string[];
        alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find elements by label
      const elementsToAlign: ExcalidrawElement[] = [];
      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          // If it's a text element with a container, get the container
          if ('containerId' in el && el.containerId) {
            const container = currentElements.find(e => e.id === el.containerId);
            if (container) {
              elementsToAlign.push(container);
            }
          } else {
            elementsToAlign.push(el);
          }
        }
      }

      if (elementsToAlign.length < 2) {
        return {
          success: false,
          error: `Need at least 2 elements to align. Found ${elementsToAlign.length}.`,
        };
      }

      // Calculate alignment reference point
      let referenceValue: number;

      switch (params.alignment) {
        case 'left':
          referenceValue = Math.min(...elementsToAlign.map(el => el.x));
          break;
        case 'center':
          const minX = Math.min(...elementsToAlign.map(el => el.x));
          const maxX = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
          referenceValue = (minX + maxX) / 2;
          break;
        case 'right':
          referenceValue = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
          break;
        case 'top':
          referenceValue = Math.min(...elementsToAlign.map(el => el.y));
          break;
        case 'middle':
          const minY = Math.min(...elementsToAlign.map(el => el.y));
          const maxY = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
          referenceValue = (minY + maxY) / 2;
          break;
        case 'bottom':
          referenceValue = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
          break;
      }

      // Build set of IDs to update (including bound text elements)
      const idsToAlign = new Set(elementsToAlign.map(el => el.id));

      // Calculate position updates
      const updates = new Map<string, { x?: number; y?: number }>();

      for (const el of elementsToAlign) {
        let newPos: { x?: number; y?: number } = {};

        switch (params.alignment) {
          case 'left':
            newPos.x = referenceValue;
            break;
          case 'center':
            newPos.x = referenceValue - (el.width || 0) / 2;
            break;
          case 'right':
            newPos.x = referenceValue - (el.width || 0);
            break;
          case 'top':
            newPos.y = referenceValue;
            break;
          case 'middle':
            newPos.y = referenceValue - (el.height || 0) / 2;
            break;
          case 'bottom':
            newPos.y = referenceValue - (el.height || 0);
            break;
        }

        updates.set(el.id, newPos);

        // Also update bound text elements
        const boundElements = (el as any).boundElements || [];
        for (const bound of boundElements) {
          if (bound.type === 'text') {
            const textEl = currentElements.find(e => e.id === bound.id);
            if (textEl) {
              const dx = (newPos.x !== undefined) ? newPos.x - el.x : 0;
              const dy = (newPos.y !== undefined) ? newPos.y - el.y : 0;
              updates.set(bound.id, {
                x: textEl.x + dx,
                y: textEl.y + dy,
              });
            }
          }
        }
      }

      // Apply updates
      const updatedElements = currentElements.map((el) => {
        const update = updates.get(el.id);
        if (update) {
          return {
            ...el,
            ...(update.x !== undefined ? { x: update.x } : {}),
            ...(update.y !== undefined ? { y: update.y } : {}),
          };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { alignedCount: elementsToAlign.length } };
    },
  },

  {
    name: 'distribute_elements',
    scope: 'global' as const,
    description: 'Distribute elements evenly with equal spacing between them. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to distribute',
        },
        direction: {
          type: 'string' as const,
          enum: ['horizontal', 'vertical'],
          description: 'Direction to distribute elements',
        },
        spacing: {
          type: 'number' as const,
          description: 'Optional fixed spacing between elements. If not provided, distributes evenly within current bounds.',
        },
      },
      required: ['labels', 'direction'],
    },
    handler: async (
      params: {
        labels: string[];
        direction: 'horizontal' | 'vertical';
        spacing?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find elements by label
      const elementsToDistribute: ExcalidrawElement[] = [];
      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          // If it's a text element with a container, get the container
          if ('containerId' in el && el.containerId) {
            const container = currentElements.find(e => e.id === el.containerId);
            if (container) {
              elementsToDistribute.push(container);
            }
          } else {
            elementsToDistribute.push(el);
          }
        }
      }

      if (elementsToDistribute.length < 3) {
        return {
          success: false,
          error: `Need at least 3 elements to distribute. Found ${elementsToDistribute.length}.`,
        };
      }

      // Sort elements by position
      if (params.direction === 'horizontal') {
        elementsToDistribute.sort((a, b) => a.x - b.x);
      } else {
        elementsToDistribute.sort((a, b) => a.y - b.y);
      }

      // Calculate distribution
      const updates = new Map<string, { x?: number; y?: number }>();

      if (params.direction === 'horizontal') {
        const firstEl = elementsToDistribute[0];
        const lastEl = elementsToDistribute[elementsToDistribute.length - 1];

        if (params.spacing !== undefined) {
          // Fixed spacing
          let currentX = firstEl.x;
          for (const el of elementsToDistribute) {
            updates.set(el.id, { x: currentX });
            currentX += (el.width || 0) + params.spacing;
          }
        } else {
          // Even distribution within bounds
          const startX = firstEl.x;
          const endX = lastEl.x;
          const totalWidth = endX - startX;
          const step = totalWidth / (elementsToDistribute.length - 1);

          elementsToDistribute.forEach((el, index) => {
            updates.set(el.id, { x: startX + index * step });
          });
        }
      } else {
        const firstEl = elementsToDistribute[0];
        const lastEl = elementsToDistribute[elementsToDistribute.length - 1];

        if (params.spacing !== undefined) {
          // Fixed spacing
          let currentY = firstEl.y;
          for (const el of elementsToDistribute) {
            updates.set(el.id, { y: currentY });
            currentY += (el.height || 0) + params.spacing;
          }
        } else {
          // Even distribution within bounds
          const startY = firstEl.y;
          const endY = lastEl.y;
          const totalHeight = endY - startY;
          const step = totalHeight / (elementsToDistribute.length - 1);

          elementsToDistribute.forEach((el, index) => {
            updates.set(el.id, { y: startY + index * step });
          });
        }
      }

      // Also move bound text elements
      for (const el of elementsToDistribute) {
        const boundElements = (el as any).boundElements || [];
        const elUpdate = updates.get(el.id);
        if (elUpdate) {
          for (const bound of boundElements) {
            if (bound.type === 'text') {
              const textEl = currentElements.find(e => e.id === bound.id);
              if (textEl) {
                const dx = elUpdate.x !== undefined ? elUpdate.x - el.x : 0;
                const dy = elUpdate.y !== undefined ? elUpdate.y - el.y : 0;
                updates.set(bound.id, {
                  x: textEl.x + dx,
                  y: textEl.y + dy,
                });
              }
            }
          }
        }
      }

      // Apply updates
      const updatedElements = currentElements.map((el) => {
        const update = updates.get(el.id);
        if (update) {
          return {
            ...el,
            ...(update.x !== undefined ? { x: update.x } : {}),
            ...(update.y !== undefined ? { y: update.y } : {}),
          };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { distributedCount: elementsToDistribute.length } };
    },
  },

  {
    name: 'move_element',
    scope: 'global' as const,
    description: 'Move an element to specific coordinates or by a relative offset. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string' as const,
          description: 'Label of the element to move',
        },
        x: {
          type: 'number' as const,
          description: 'New X position (absolute)',
        },
        y: {
          type: 'number' as const,
          description: 'New Y position (absolute)',
        },
        dx: {
          type: 'number' as const,
          description: 'Relative X offset (use instead of x for relative movement)',
        },
        dy: {
          type: 'number' as const,
          description: 'Relative Y offset (use instead of y for relative movement)',
        },
      },
      required: ['label'],
    },
    handler: async (
      params: {
        label: string;
        x?: number;
        y?: number;
        dx?: number;
        dy?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (params.x === undefined && params.y === undefined && params.dx === undefined && params.dy === undefined) {
        return {
          success: false,
          error: 'Must provide x/y coordinates or dx/dy offsets',
        };
      }

      const currentElements = api.getSceneElements();
      const element = getElementByLabel(currentElements, params.label);

      if (!element) {
        return {
          success: false,
          error: `Element not found: ${params.label}`,
        };
      }

      // Get the container if this is a text element
      let targetElement = element;
      if ('containerId' in element && element.containerId) {
        const container = currentElements.find(e => e.id === element.containerId);
        if (container) {
          targetElement = container;
        }
      }

      // Calculate new position
      let newX = targetElement.x;
      let newY = targetElement.y;

      if (params.x !== undefined) newX = params.x;
      if (params.y !== undefined) newY = params.y;
      if (params.dx !== undefined) newX = targetElement.x + params.dx;
      if (params.dy !== undefined) newY = targetElement.y + params.dy;

      const dx = newX - targetElement.x;
      const dy = newY - targetElement.y;

      // Build list of elements to move (container + bound text)
      const idsToMove = new Set([targetElement.id]);
      const boundElements = (targetElement as any).boundElements || [];
      for (const bound of boundElements) {
        if (bound.type === 'text') {
          idsToMove.add(bound.id);
        }
      }

      // Apply updates
      const updatedElements = currentElements.map((el) => {
        if (idsToMove.has(el.id)) {
          return {
            ...el,
            x: el.x + dx,
            y: el.y + dy,
          };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { newX, newY } };
    },
  },

  {
    name: 'group_elements',
    scope: 'global' as const,
    description: 'Group multiple elements together so they move as a unit. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to group together',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (params.labels.length < 2) {
        return {
          success: false,
          error: 'Need at least 2 elements to group',
        };
      }

      const currentElements = api.getSceneElements();
      const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Find all element IDs to group (including containers and bound text)
      const idsToGroup = new Set<string>();

      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          idsToGroup.add(el.id);

          // If text with container, also add container
          if ('containerId' in el && el.containerId) {
            idsToGroup.add(el.containerId as string);
          }

          // If container with bound text, also add text
          const boundElements = (el as any).boundElements || [];
          for (const bound of boundElements) {
            idsToGroup.add(bound.id);
          }
        }
      }

      // Apply group ID to all elements
      const updatedElements = currentElements.map((el) => {
        if (idsToGroup.has(el.id)) {
          const existingGroups = (el as any).groupIds || [];
          return {
            ...el,
            groupIds: [...existingGroups, groupId],
          };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { groupId, elementCount: idsToGroup.size } };
    },
  },

  {
    name: 'set_elements_in_frame',
    scope: 'global' as const,
    description: 'Move elements into a frame so they become children of that frame. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        frameLabel: {
          type: 'string' as const,
          description: 'Name/label of the frame',
        },
        elementLabels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to put in the frame',
        },
      },
      required: ['frameLabel', 'elementLabels'],
    },
    handler: async (
      params: {
        frameLabel: string;
        elementLabels: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find frame by name
      const frame = currentElements.find(
        el => el.type === 'frame' && (el as any).name === params.frameLabel
      );

      if (!frame) {
        return {
          success: false,
          error: `Frame not found: ${params.frameLabel}`,
        };
      }

      // Find all element IDs to add to frame
      const idsToAddToFrame = new Set<string>();

      for (const label of params.elementLabels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          idsToAddToFrame.add(el.id);

          // If text with container, also add container
          if ('containerId' in el && el.containerId) {
            idsToAddToFrame.add(el.containerId as string);
          }

          // If container with bound text, also add text
          const boundElements = (el as any).boundElements || [];
          for (const bound of boundElements) {
            idsToAddToFrame.add(bound.id);
          }
        }
      }

      // Set frameId on all elements
      const updatedElements = currentElements.map((el) => {
        if (idsToAddToFrame.has(el.id)) {
          return {
            ...el,
            frameId: frame.id,
          };
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { frameId: frame.id, elementCount: idsToAddToFrame.size } };
    },
  },

  {
    name: 'add_arrows',
    scope: 'global' as const,
    description: 'Add multiple arrows in a single batch operation. Much more efficient than calling add_arrow repeatedly when creating diagrams with many connections. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        arrows: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              from: {
                type: 'string' as const,
                description: 'Label of the source element',
              },
              to: {
                type: 'string' as const,
                description: 'Label of the target element',
              },
              label: {
                type: 'string' as const,
                description: 'Optional label for the arrow',
              },
            },
            required: ['from', 'to'],
          },
          description: 'Array of arrow definitions to create',
        },
      },
      required: ['arrows'],
    },
    handler: async (
      params: {
        arrows: Array<{ from: string; to: string; label?: string }>;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();
      const newArrows: any[] = [];
      const elementUpdates = new Map<string, any>();
      const createdIds: string[] = [];
      const errors: string[] = [];

      // Process each arrow
      for (const arrowDef of params.arrows) {
        const fromEl = getElementByLabel(currentElements, arrowDef.from);
        const toEl = getElementByLabel(currentElements, arrowDef.to);

        if (!fromEl || !toEl) {
          errors.push(`Could not find elements: ${!fromEl ? arrowDef.from : ''} ${!toEl ? arrowDef.to : ''}`);
          continue;
        }

        // Get container elements if bound to text
        let fromContainerId = fromEl.id;
        let toContainerId = toEl.id;

        if ('containerId' in fromEl && fromEl.containerId) {
          fromContainerId = fromEl.containerId as string;
        }
        if ('containerId' in toEl && toEl.containerId) {
          toContainerId = toEl.containerId as string;
        }

        const fromContainer = currentElements.find(el => el.id === fromContainerId) || fromEl;
        const toContainer = currentElements.find(el => el.id === toContainerId) || toEl;

        // Calculate edge intersection points
        const fromCenterX = fromContainer.x + (fromContainer.width || 0) / 2;
        const fromCenterY = fromContainer.y + (fromContainer.height || 0) / 2;
        const toCenterX = toContainer.x + (toContainer.width || 0) / 2;
        const toCenterY = toContainer.y + (toContainer.height || 0) / 2;

        const gap = 8;
        const fromEdge = calculateEdgePoint(fromContainer, toCenterX, toCenterY, gap);
        const toEdge = calculateEdgePoint(toContainer, fromCenterX, fromCenterY, gap);

        const arrowId = `arrow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create arrow element
        const arrow: any = {
          id: arrowId,
          type: 'arrow',
          x: fromEdge.x,
          y: fromEdge.y,
          width: toEdge.x - fromEdge.x,
          height: toEdge.y - fromEdge.y,
          angle: 0,
          strokeColor: '#1e1e1e',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: { type: 2 },
          seed: Math.floor(Math.random() * 1000000),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
          points: [
            [0, 0],
            [toEdge.x - fromEdge.x, toEdge.y - fromEdge.y],
          ],
          lastCommittedPoint: null,
          startBinding: {
            elementId: fromContainerId,
            focus: 0,
            gap,
          },
          endBinding: {
            elementId: toContainerId,
            focus: 0,
            gap,
          },
          startArrowhead: null,
          endArrowhead: 'arrow',
        };

        newArrows.push(arrow);
        createdIds.push(arrowId);

        // Track bound element updates
        for (const containerId of [fromContainerId, toContainerId]) {
          if (!elementUpdates.has(containerId)) {
            const el = currentElements.find(e => e.id === containerId);
            if (el) {
              elementUpdates.set(containerId, {
                ...el,
                boundElements: [...((el as any).boundElements || [])],
              });
            }
          }
          const updated = elementUpdates.get(containerId);
          if (updated) {
            updated.boundElements.push({ id: arrowId, type: 'arrow' });
          }
        }
      }

      // Apply all updates in a single scene update
      const updatedElements = currentElements.map(el =>
        elementUpdates.has(el.id) ? elementUpdates.get(el.id) : el
      );

      api.updateScene({
        elements: [...updatedElements, ...newArrows],
      });

      return {
        success: true,
        data: {
          created: createdIds.length,
          ids: createdIds,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    },
  },

  {
    name: 'add_elements',
    scope: 'global' as const,
    description: 'Add multiple rectangles in a single batch operation. Much more efficient than calling add_rectangle repeatedly when creating diagrams with many elements. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        elements: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              label: {
                type: 'string' as const,
                description: 'Text label for the rectangle',
              },
              x: {
                type: 'number' as const,
                description: 'X position (left edge). If not provided, auto-positions.',
              },
              y: {
                type: 'number' as const,
                description: 'Y position (top edge). If not provided, auto-positions.',
              },
              width: {
                type: 'number' as const,
                description: 'Width of the rectangle (default: 150)',
              },
              height: {
                type: 'number' as const,
                description: 'Height of the rectangle (default: 80)',
              },
              color: {
                type: 'string' as const,
                description: 'Fill color (hex code or color name)',
              },
              strokeColor: {
                type: 'string' as const,
                description: 'Border color (hex code or color name)',
              },
              rounded: {
                type: 'boolean' as const,
                description: 'Whether to use rounded corners (default: true)',
              },
            },
            required: ['label'],
          },
          description: 'Array of rectangle definitions to create',
        },
      },
      required: ['elements'],
    },
    handler: async (
      params: {
        elements: Array<{
          label: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          color?: string;
          strokeColor?: string;
          rounded?: boolean;
        }>;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const skeletons: any[] = [];
      const createdIds: string[] = [];

      // Create all rectangles
      for (const elemDef of params.elements) {
        const width = elemDef.width || 150;
        const height = elemDef.height || 80;
        const rounded = elemDef.rounded !== undefined ? elemDef.rounded : true;

        let position: { x: number; y: number };

        if (elemDef.x !== undefined && elemDef.y !== undefined) {
          position = { x: elemDef.x, y: elemDef.y };
        } else {
          position = engine.calculateDefaultPosition(width, height);
        }

        const rectSkeleton: any = {
          type: 'rectangle',
          x: position.x,
          y: position.y,
          width,
          height,
          backgroundColor: normalizeColor(elemDef.color) || 'transparent',
          strokeColor: normalizeColor(elemDef.strokeColor) || '#1e1e1e',
          roundness: rounded ? { type: 3 } : null,
          label: {
            text: elemDef.label,
          },
        };

        skeletons.push(rectSkeleton);
      }

      const newElements = convertToExcalidrawElements(skeletons);
      const rectangleIds = newElements.filter(el => el.type === 'rectangle').map(el => el.id);

      api.updateScene({
        elements: [...currentElements, ...newElements],
      });

      return {
        success: true,
        data: {
          created: rectangleIds.length,
          ids: rectangleIds,
        },
      };
    },
  },

  {
    name: 'remove_elements',
    scope: 'global' as const,
    description: 'Remove multiple elements in a single batch operation. Much more efficient than calling remove_element repeatedly. Requires an open .excalidraw file.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to remove',
        },
        ids: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Element IDs to remove (alternative to labels)',
        },
      },
    },
    handler: async (
      params: {
        labels?: string[];
        ids?: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if ((!params.labels || params.labels.length === 0) && (!params.ids || params.ids.length === 0)) {
        return {
          success: false,
          error: 'Must provide either labels or ids array',
        };
      }

      const currentElements = api.getSceneElements();
      const idsToRemove = new Set<string>();

      // Find elements by labels
      if (params.labels) {
        for (const label of params.labels) {
          const element = getElementByLabel(currentElements, label);
          if (element) {
            idsToRemove.add(element.id);
            // If it's bound text, also remove container
            if ('containerId' in element && element.containerId) {
              idsToRemove.add(element.containerId as string);
            }
          }
        }
      }

      // Find elements by IDs
      if (params.ids) {
        for (const id of params.ids) {
          const element = currentElements.find(el => el.id === id);
          if (element) {
            idsToRemove.add(id);
            // If it's bound text, also remove container
            if ('containerId' in element && element.containerId) {
              idsToRemove.add(element.containerId as string);
            }
          }
        }
      }

      const updatedElements = currentElements.filter((el) => !idsToRemove.has(el.id));

      api.updateScene({ elements: updatedElements });

      return {
        success: true,
        data: {
          removed: idsToRemove.size,
        },
      };
    },
  },
];
