interface TrackerActivityLike {
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
}

function quoted(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const bounded = compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
  return `“${bounded}”`;
}

function changed(label: string, entry: TrackerActivityLike): string {
  if (entry.oldValue !== undefined && entry.newValue !== undefined) {
    return `changed ${label} from ${quoted(entry.oldValue)} to ${quoted(entry.newValue)}`;
  }
  if (entry.newValue !== undefined) return `changed ${label} to ${quoted(entry.newValue)}`;
  return `updated ${label}`;
}

export function formatTrackerActivity(entry: TrackerActivityLike): string {
  if (entry.action === 'created') return 'created this item';
  if (entry.action === 'commented') return 'added a comment';
  if (entry.action === 'comment_updated') {
    if (entry.oldValue !== undefined && entry.newValue !== undefined) {
      return `edited a comment from ${quoted(entry.oldValue)} to ${quoted(entry.newValue)}`;
    }
    return 'edited a comment';
  }
  if (entry.action === 'comment_deleted') {
    return entry.oldValue !== undefined ? `deleted comment ${quoted(entry.oldValue)}` : 'deleted a comment';
  }
  if (entry.action === 'archived') {
    return entry.newValue === 'true' ? 'archived this item' : 'unarchived this item';
  }
  if (entry.action === 'status_changed') return changed('status', entry);
  if (entry.action === 'type_changed') return changed('type', entry);
  if (entry.field) return changed(entry.field, entry);
  return entry.action.replace(/_/g, ' ');
}
