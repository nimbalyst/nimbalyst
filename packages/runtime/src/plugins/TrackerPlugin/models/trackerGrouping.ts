import type { TrackerIdentity } from '../../../core/DocumentService';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { getFieldByRole, getRecordPriority, getRecordStatus } from '../trackerRecordAccessors';
import { getCollectionField } from './trackerCollections';
import { globalRegistry, type FieldDefinition, type TrackerRelationshipValue } from '@nimbalyst/tracker-schema';
import { isRelationshipField, normalizeRelationshipValue } from './trackerRelationships';

export const TRACKER_GROUPING_AXES = [
  'status',
  'priority',
  'assignee',
  'type',
  'tag',
  'milestone',
  'goal',
] as const;

export type BuiltinTrackerGroupingAxis = (typeof TRACKER_GROUPING_AXES)[number];
export type TrackerFieldGrouping = { kind: 'field'; fieldId: string };
export type TrackerGroupingAxis = BuiltinTrackerGroupingAxis | TrackerFieldGrouping;
export type TrackerGroupBy = 'none' | TrackerGroupingAxis;

export interface TrackerGroupingOption {
  value: BuiltinTrackerGroupingAxis;
  label: string;
}

export const TRACKER_GROUPING_OPTIONS: readonly TrackerGroupingOption[] = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'type', label: 'Type' },
  { value: 'tag', label: 'Tag' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'goal', label: 'Goal' },
];

export interface ResolvedTrackerGroup {
  /** Axis-namespaced key suitable for React keys, persisted lane ids, and DnD. */
  key: string;
  /** Stored scalar value, relationship item id, or null for the empty bucket. */
  value: string | null;
  /** User-facing bucket label. */
  label: string;
  /** True only for the axis-specific no-value bucket. */
  empty: boolean;
}

export interface TrackerRecordGroup {
  key: string;
  label: string;
  items: TrackerRecord[];
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

/** Schema names for badges and group headings; unknown types keep their id. */
export function getTrackerTypeLabel(type: string, plural = false): string {
  const model = globalRegistry.get(type);
  if (!model) return type;
  return (plural && model.displayNamePlural) || model.displayName;
}

function groupKey(axis: TrackerGroupingAxis, value: string | null): string {
  const key = typeof axis === 'string' ? axis : `field:${axis.fieldId}`;
  return value === null ? `${key}:empty` : `${key}:value:${encodeURIComponent(value)}`;
}

function emptyLabel(axis: TrackerGroupingAxis): string {
  switch (axis) {
    case 'assignee': return 'Unassigned';
    case 'tag': return 'Untagged';
    case 'milestone': return 'No milestone';
    case 'goal': return 'No goal';
    default: return 'None';
  }
}

export function resolveEmptyTrackerGroup(axis: TrackerGroupingAxis): ResolvedTrackerGroup {
  return { key: groupKey(axis, null), value: null, label: emptyLabel(axis), empty: true };
}

function scalarGroup(axis: TrackerGroupingAxis, value: unknown, label?: string): ResolvedTrackerGroup {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  if (!normalized) return resolveEmptyTrackerGroup(axis);
  return {
    key: groupKey(axis, normalized),
    value: normalized,
    label: label || titleCase(normalized),
    empty: false,
  };
}

function identityParts(value: unknown): { value: string; label: string } | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? { value: normalized.toLowerCase(), label: normalized } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<TrackerIdentity> & Record<string, unknown>;
  const stableValue = [identity.email, identity.gitEmail, identity.displayName, identity.gitName]
    .find(candidate => typeof candidate === 'string' && candidate.trim());
  const label = [identity.displayName, identity.email, identity.gitName, identity.gitEmail]
    .find(candidate => typeof candidate === 'string' && candidate.trim());
  if (typeof stableValue !== 'string' || typeof label !== 'string') return null;
  return { value: stableValue.trim().toLowerCase(), label: label.trim() };
}

/** Axes whose membership is a relationship rather than a scalar field. */
export type TrackerRelationshipGroupingAxis = 'milestone' | 'goal';

/**
 * The schema field an item uses to name its milestone(s) or goal(s).
 *
 * Writers need the definition itself (for `multiValue` and the relationship
 * vocabulary keys), so this is exported alongside the name-only form the
 * read path uses.
 */
export function resolveGroupingRelationshipField(
  type: string,
  axis: TrackerRelationshipGroupingAxis,
): FieldDefinition | undefined {
  if (axis === 'milestone') return getCollectionField(type);
  return globalRegistry.get(type)?.fields.find(field => {
    if (!isRelationshipField(field)) return false;
    const targets = field.targetTrackerTypes;
    return Array.isArray(targets) && targets.includes('goal');
  });
}

/** Field name for {@link resolveGroupingRelationshipField}, falling back to the built-in name. */
export function resolveGroupingRelationshipFieldName(
  type: string,
  axis: TrackerRelationshipGroupingAxis,
): string {
  return resolveGroupingRelationshipField(type, axis)?.name
    ?? (axis === 'milestone' ? 'collection' : 'goal');
}

/**
 * The relationship values that place an item on a relationship axis.
 *
 * The board reuses this so a lane's stored membership and its drag target are
 * filtered by one rule, not two.
 */
export function resolveGroupingRelationshipValues(
  item: TrackerRecord,
  axis: TrackerRelationshipGroupingAxis,
): TrackerRelationshipValue[] {
  const fieldName = resolveGroupingRelationshipFieldName(item.primaryType, axis);
  return normalizeRelationshipValue(item.fields[fieldName])
    // `collection` can also point to releases. A denormalized target type is
    // authoritative when present; legacy values without one remain visible so
    // older persisted relationships do not silently disappear.
    .filter(value => !value.trackerType || value.trackerType === axis);
}

/**
 * Reads the current title of a referenced item, when the caller can see it.
 *
 * The `title` stored on a relationship is a snapshot taken when the link was
 * written: it is absent when the link was written from the other side, and
 * stale after the target is renamed. Surfaces with the tracker's records in
 * hand pass this so a milestone lane reads "Onboarding" rather than
 * `milestone_1786137761427_n9d75j`.
 */
export type TrackerRelationshipLabelResolver = (itemId: string) => string | undefined;

/** The best available name for a relationship value: live title, then snapshot. */
export function resolveRelationshipLabel(
  value: Pick<TrackerRelationshipValue, 'itemId' | 'title' | 'issueKey'>,
  resolveLabel?: TrackerRelationshipLabelResolver,
): string {
  return resolveLabel?.(value.itemId)?.trim()
    || value.title
    || value.issueKey
    || value.itemId;
}

function relationshipGroups(
  item: TrackerRecord,
  axis: TrackerRelationshipGroupingAxis,
  resolveLabel?: TrackerRelationshipLabelResolver,
): ResolvedTrackerGroup[] {
  const values = resolveGroupingRelationshipValues(item, axis);
  const groups = values.map(value => {
    const label = resolveRelationshipLabel(value, resolveLabel);
    return {
      key: groupKey(axis, value.itemId),
      value: value.itemId,
      label,
      empty: false,
    } satisfies ResolvedTrackerGroup;
  });
  return groups.length > 0 ? dedupeGroups(groups) : [resolveEmptyTrackerGroup(axis)];
}

function dedupeGroups(groups: ResolvedTrackerGroup[]): ResolvedTrackerGroup[] {
  return [...new Map(groups.map(group => [group.key, group])).values()];
}

/** Resolve every bucket an item belongs to for one grouping axis. */
export function resolveTrackerGroups(
  item: TrackerRecord,
  axis: TrackerGroupingAxis,
  resolveLabel?: TrackerRelationshipLabelResolver,
): ResolvedTrackerGroup[] {
  if (typeof axis === 'object') {
    const field = globalRegistry.get(item.primaryType)?.fields.find(candidate => candidate.name === axis.fieldId);
    const value = item.fields[axis.fieldId];
    if (!field || field.multiValue || !['select', 'boolean', 'user', 'relationship'].includes(field.type)) return [resolveEmptyTrackerGroup(axis)];
    if (field.type === 'relationship') {
      const refs = normalizeRelationshipValue(value);
      return refs.length ? refs.map(ref => scalarGroup(axis, ref.itemId, resolveRelationshipLabel(ref, resolveLabel))) : [resolveEmptyTrackerGroup(axis)];
    }
    if (field.type === 'user') {
      const person = identityParts(value);
      return [person ? scalarGroup(axis, person.value, person.label) : resolveEmptyTrackerGroup(axis)];
    }
    const option = field.options?.find(option => (typeof option === 'string' ? option : option.value) === String(value));
    return [scalarGroup(axis, value, typeof option === 'object' ? option.label : undefined)];
  }
  switch (axis) {
    case 'status':
      return [scalarGroup(axis, getRecordStatus(item))];
    case 'priority':
      return [scalarGroup(axis, getRecordPriority(item))];
    case 'type':
      return [scalarGroup(axis, item.primaryType,
        globalRegistry.get(item.primaryType) ? getTrackerTypeLabel(item.primaryType, true) : undefined)];
    case 'assignee': {
      const identity = identityParts(getFieldByRole(item, 'assignee'));
      return [identity ? scalarGroup(axis, identity.value, identity.label) : resolveEmptyTrackerGroup(axis)];
    }
    case 'tag': {
      const raw = getFieldByRole(item, 'tags');
      const tags = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const groups = tags
        .filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
        .map(tag => scalarGroup(axis, tag.trim(), `#${tag.trim()}`));
      return groups.length > 0 ? dedupeGroups(groups) : [resolveEmptyTrackerGroup(axis)];
    }
    case 'milestone':
    case 'goal':
      return relationshipGroups(item, axis, resolveLabel);
  }
}

/** Group records in first-seen order; multi-value axes intentionally duplicate membership. */
export function groupTrackerRecordsByAxis(
  items: TrackerRecord[],
  groupBy: TrackerGroupBy,
  resolveLabel?: TrackerRelationshipLabelResolver,
): TrackerRecordGroup[] {
  if (groupBy === 'none') return [{ key: 'none:all', label: 'All', items }];
  const buckets = new Map<string, TrackerRecordGroup>();
  for (const item of items) {
    for (const resolved of resolveTrackerGroups(item, groupBy, resolveLabel)) {
      const bucket = buckets.get(resolved.key);
      if (bucket) bucket.items.push(item);
      else buckets.set(resolved.key, { key: resolved.key, label: resolved.label, items: [item] });
    }
  }
  const groups = [...buckets.values()];
  return [
    ...groups.filter(group => !group.key.endsWith(':empty')),
    ...groups.filter(group => group.key.endsWith(':empty')),
  ];
}

export function normalizeTrackerGroupBy(value: unknown): TrackerGroupBy {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'field' && 'fieldId' in value && typeof value.fieldId === 'string' && value.fieldId.trim()) return { kind: 'field', fieldId: value.fieldId };
  if (value === 'owner') return 'assignee';
  return (TRACKER_GROUPING_AXES as readonly unknown[]).includes(value)
    ? value as TrackerGroupingAxis
    : 'none';
}
