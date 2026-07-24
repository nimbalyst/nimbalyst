/**
 * MockupLM Project Types
 *
 * Defines the .mockupproject file format for organizing
 * mockups on an infinite canvas with navigation flows.
 */

export interface MockupReference {
  /** Relative path to the .mockup.html file */
  path: string;
  /** Position on the canvas */
  position: { x: number; y: number };
  /** Display size of the card on canvas */
  size: { width: number; height: number };
  /** Display label (defaults to filename) */
  label: string;
  /** Unique ID for this reference */
  id: string;
}

export interface Connection {
  /** Unique ID */
  id: string;
  /** Source mockup reference ID */
  fromMockupId: string;
  /** Target mockup reference ID */
  toMockupId: string;
  /** Optional CSS selector of the triggering element in the source mockup */
  fromElementSelector?: string;
  /** Label for the connection (e.g., "Click Advanced") */
  label?: string;
  /** Trigger type */
  trigger?: 'click' | 'hover' | 'navigate';
}

export interface DesignSystemRef {
  /** Path to a style guide mockup */
  styleGuide?: string;
  /** Active theme name */
  theme?: string;
}

export interface MockupProjectFile {
  version: 1;
  name: string;
  description?: string;
  designSystem?: DesignSystemRef;
  mockups: MockupReference[];
  connections: Connection[];
  viewport: { x: number; y: number; zoom: number };
}

export function createEmptyProject(name = 'New Project'): MockupProjectFile {
  return {
    version: 1,
    name,
    mockups: [],
    connections: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
