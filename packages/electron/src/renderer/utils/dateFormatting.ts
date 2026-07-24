export type TimeGroupKey =
  | 'Today'
  | 'Yesterday'
  | 'This Week'
  | 'Last Week'
  | 'This Month'
  | 'Last Month'
  | 'Older';

export interface GroupedSessions<T> {
  [key: string]: T[];
}

export function getRelativeTimeString(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  // Under a minute
  if (diff < 60 * 1000) {
    return 'Just now';
  }

  // Under an hour - show minutes
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return `${minutes} ${minutes === 1 ? 'min' : 'mins'} ago`;
  }

  // Under a day - show hours
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours} ${hours === 1 ? 'hr' : 'hrs'} ago`;
  }

  // Under a week - show days
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }

  // Under a month - show weeks
  if (diff < 30 * 24 * 60 * 60 * 1000) {
    const weeks = Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }

  // Under a year - show months
  if (diff < 365 * 24 * 60 * 60 * 1000) {
    const months = Math.floor(diff / (30 * 24 * 60 * 60 * 1000));
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }

  // Over a year - show years
  const years = Math.floor(diff / (365 * 24 * 60 * 60 * 1000));
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

export function getTimeGroupKey(timestamp: number): TimeGroupKey {
  const now = new Date();
  const date = new Date(timestamp);

  // Reset time to midnight for comparison
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const daysDiff = Math.floor((todayStart.getTime() - dateStart.getTime()) / (24 * 60 * 60 * 1000));

  // Today
  if (daysDiff === 0) {
    return 'Today';
  }

  // Yesterday
  if (daysDiff === 1) {
    return 'Yesterday';
  }

  // This Week (within 7 days and in current week)
  if (daysDiff < 7 && daysDiff > 1) {
    // Check if it's in the current week (week starts on Sunday)
    const currentWeekStart = new Date(todayStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay());

    if (dateStart >= currentWeekStart) {
      return 'This Week';
    }
  }

  // Last Week
  if (daysDiff < 14) {
    return 'Last Week';
  }

  // This Month
  if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
    return 'This Month';
  }

  // Last Month
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (date.getMonth() === lastMonth.getMonth() && date.getFullYear() === lastMonth.getFullYear()) {
    return 'Last Month';
  }

  // Older
  return 'Older';
}

export function groupSessionsByTime<T extends { createdAt: number; updatedAt?: number }>(
  sessions: T[],
  timestampField: 'createdAt' | 'updatedAt' = 'createdAt'
): GroupedSessions<T> {
  const groups: GroupedSessions<T> = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'Last Week': [],
    'This Month': [],
    'Last Month': [],
    'Older': []
  };

  // Sort sessions by the specified timestamp field (newest first)
  const sorted = [...sessions].sort((a, b) => {
    const aTime = timestampField === 'updatedAt' && a.updatedAt ? a.updatedAt : a.createdAt;
    const bTime = timestampField === 'updatedAt' && b.updatedAt ? b.updatedAt : b.createdAt;
    return bTime - aTime;
  });

  // Group sessions
  for (const session of sorted) {
    const timestamp = timestampField === 'updatedAt' && session.updatedAt ? session.updatedAt : session.createdAt;
    const group = getTimeGroupKey(timestamp);
    groups[group].push(session);
  }

  // Remove empty groups and return
  return Object.fromEntries(
    Object.entries(groups).filter(([_, sessions]) => sessions.length > 0)
  );
}
