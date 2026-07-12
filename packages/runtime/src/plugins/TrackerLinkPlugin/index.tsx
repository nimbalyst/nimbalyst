/**
 * TrackerLinkPlugin — inline references (pointers) to tracker items in markdown.
 *
 * See {@link TrackerReferenceNode} for the reference-vs-snapshot design.
 * V1 surface: node + markdown round-trip + live chip. The `#` editor typeahead
 * picker is a planned V2 follow-up.
 */

export {
  TrackerReferenceNode,
  $createTrackerReferenceNode,
  $isTrackerReferenceNode,
  TRACKER_REFERENCE_URN_SCHEME,
  type SerializedTrackerReferenceNode,
} from './TrackerReferenceNode';

export { TrackerReferenceTransformer } from './TrackerReferenceTransformer';

export {
  TrackerReferenceChip,
  type TrackerReferenceChipProps,
} from './TrackerReferenceChip';
export {
  TrackerReferencePicker,
  type TrackerReferencePickerProps,
} from './TrackerReferencePickerComponent';

export {
  useResolvedTrackerReference,
  navigateToTrackerReference,
  type ResolvedTrackerReference,
} from './trackerReferenceData';
