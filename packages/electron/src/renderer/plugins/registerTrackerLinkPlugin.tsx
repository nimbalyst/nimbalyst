/**
 * Register the tracker-reference node and its markdown transformer through the
 * shared reference-node registration, plus the renderer-only live chip.
 */

import {
  setTrackerReferenceNodeRenderer,
  TrackerReferenceChip,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';
import { registerTrackerReferenceContributions } from '@nimbalyst/runtime/plugins/referenceNodeContributions';

export function registerTrackerLinkPlugin(): void {
  setTrackerReferenceNodeRenderer(TrackerReferenceChip);
  registerTrackerReferenceContributions();
}
