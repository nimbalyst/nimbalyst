import type { NodeKey } from 'lexical';
import type { ComponentType } from 'react';

export interface TrackerReferenceNodeRendererProps {
  referenceKey: string;
  nodeKey: NodeKey;
}

let trackerReferenceNodeRenderer:
  | ComponentType<TrackerReferenceNodeRendererProps>
  | undefined;

export function setTrackerReferenceNodeRenderer(
  renderer:
    | ComponentType<TrackerReferenceNodeRendererProps>
    | undefined,
): void {
  trackerReferenceNodeRenderer = renderer;
}

export function getTrackerReferenceNodeRenderer():
  | ComponentType<TrackerReferenceNodeRendererProps>
  | undefined {
  return trackerReferenceNodeRenderer;
}
