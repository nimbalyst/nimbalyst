/**
 * Factory functions for creating Excalidraw elements
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

interface RectangleOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
  style?: 'default' | 'highlight' | 'muted';
  backgroundColor?: string;
  strokeColor?: string;
  roundness?: { type: number } | null;
  groupIds?: string[];
}

// Helper to convert color names to Excalidraw default palette
function normalizeColor(color?: string): string | undefined {
  if (!color) return undefined;

  // Map color names to Excalidraw's default pastel palette
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

export function createRectangle(options: RectangleOptions): ExcalidrawElement {
  const {
    x,
    y,
    width = 150,
    height = 80,
    style = 'default',
    backgroundColor,
    strokeColor,
    roundness,
    groupIds = [],
  } = options;

  // Map styles to colors (only used if explicit colors not provided)
  const styleColors: Record<string, string> = {
    default: '#1971c2',
    highlight: '#f08c00',
    muted: '#868e96',
  };

  return {
    id: generateId(),
    type: 'rectangle',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: normalizeColor(strokeColor) || styleColors[style] || styleColors.default,
    backgroundColor: normalizeColor(backgroundColor) || 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds,
    frameId: null,
    roundness: roundness !== undefined ? roundness : { type: 3 },
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
  } as any;
}

interface TextOptions {
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  containerId?: string;
}

export function createText(options: TextOptions): ExcalidrawElement {
  const { x, y, text, fontSize = 20, containerId } = options;

  // Estimate text dimensions
  const charWidth = fontSize * 0.6;
  const width = text.length * charWidth;
  const height = fontSize * 1.5;

  return {
    id: generateId(),
    type: 'text',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    text,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    baseline: fontSize,
    containerId: containerId || null,
    originalText: text,
    lineHeight: 1.25,
  } as any;
}

interface ArrowOptions {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startElementId?: string;
  endElementId?: string;
  label?: string;
  groupIds?: string[];
}

export function createArrow(options: ArrowOptions): ExcalidrawElement[] {
  const {
    startX,
    startY,
    endX,
    endY,
    startElementId,
    endElementId,
    label,
    groupIds = [],
  } = options;

  const elements: ExcalidrawElement[] = [];

  const arrowId = generateId();

  const arrow: any = {
    id: arrowId,
    type: 'arrow',
    x: startX,
    y: startY,
    width: endX - startX,
    height: endY - startY,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds,
    frameId: null,
    roundness: { type: 2 },
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    points: [
      [0, 0],
      [endX - startX, endY - startY],
    ],
    lastCommittedPoint: null,
    startBinding: startElementId
      ? {
          elementId: startElementId,
          focus: 0,
          gap: 10,
        }
      : null,
    endBinding: endElementId
      ? {
          elementId: endElementId,
          focus: 0,
          gap: 10,
        }
      : null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  };

  elements.push(arrow);

  // Add label if provided
  if (label) {
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;

    const labelElement = createText({
      x: midX - (label.length * 10) / 2,
      y: midY - 10,
      text: label,
      fontSize: 16,
    });

    // Make label part of same group
    (labelElement as any).groupIds = groupIds;

    elements.push(labelElement);
  }

  return elements;
}

interface LabeledRectangleResult {
  rectangle: ExcalidrawElement;
  text: ExcalidrawElement;
}

export function createLabeledRectangle(options: RectangleOptions): LabeledRectangleResult {
  const {
    x,
    y,
    width = 150,
    height = 80,
    text,
    groupIds = [],
  } = options;

  const rectangle = createRectangle({ ...options, text: '' });
  const rectId = rectangle.id;

  // Center text in rectangle
  const textElement = createText({
    x: x + width / 2 - (text.length * 10) / 2,
    y: y + height / 2 - 10,
    text,
    fontSize: 16,
    containerId: rectId,
  });

  // Text should have same groupIds
  (textElement as any).groupIds = groupIds;

  // Link rectangle to text
  (rectangle as any).boundElements = [{ id: textElement.id, type: 'text' }];

  return {
    rectangle,
    text: textElement,
  };
}

interface FrameOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
}

/**
 * Create a frame element (container with dashed border and title)
 */
export function createFrame(options: FrameOptions): ExcalidrawElement {
  const { x, y, width, height, name } = options;

  return {
    id: generateId(),
    type: 'frame',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    name: name || null,
  } as any;
}
