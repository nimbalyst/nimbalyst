/**
 * Parse and update automationStatus frontmatter in markdown files.
 */

import jsyaml from 'js-yaml';
import type { AutomationStatus } from './types';

// Tolerate CRLF on Windows where git core.autocrlf delivers files with `\r\n`.
// Without `\r?\n` the regex fails on a `---\r\n` opener and the file looks
// frontmatter-less to every consumer of these helpers (Tracker view,
// automations daemon, etc.). See nimbalyst#68.
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Extract the automationStatus from a markdown file's frontmatter.
 * Returns null if no frontmatter or no automationStatus block.
 */
export function parseAutomationStatus(content: string): AutomationStatus | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return null;

  try {
    const parsed = jsyaml.load(match[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.automationStatus) return null;
    return parsed.automationStatus as AutomationStatus;
  } catch {
    return null;
  }
}

/**
 * Extract the markdown body (everything after frontmatter).
 */
export function extractPromptBody(content: string): string {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return content;
  return content.slice(match[0].length).trim();
}

/**
 * Update the automationStatus in a markdown file's frontmatter.
 * Preserves non-automation frontmatter fields and the markdown body.
 */
export function updateAutomationStatus(
  content: string,
  updates: Partial<AutomationStatus>,
): string {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return content;

  try {
    const parsed = jsyaml.load(match[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !parsed.automationStatus) {
      return content;
    }

    const current = parsed.automationStatus as Record<string, unknown>;
    // Replace (not merge) nested objects like schedule and output
    // so stale fields from a different schedule type don't persist
    const merged = { ...current };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    parsed.automationStatus = merged;

    const yamlContent = jsyaml.dump(parsed, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
    });

    return content.replace(FRONTMATTER_REGEX, `---\n${yamlContent}---`);
  } catch {
    return content;
  }
}

/**
 * Check if content has valid automationStatus frontmatter.
 */
export function hasAutomationStatus(content: string): boolean {
  return parseAutomationStatus(content) !== null;
}

/**
 * Generate a human-readable schedule description.
 */
export function describeSchedule(status: AutomationStatus): string {
  const { schedule } = status;

  switch (schedule.type) {
    case 'interval':
      return `Every ${schedule.intervalMinutes} minutes`;

    case 'daily':
      return `Daily at ${formatTime(schedule.time)}`;

    case 'weekly': {
      const { days } = schedule;
      const isWeekdays =
        days.length === 5 &&
        ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => days.includes(d as never));
      const isWeekends =
        days.length === 2 &&
        ['sat', 'sun'].every((d) => days.includes(d as never));
      const isEveryDay = days.length === 7;

      let dayStr: string;
      if (isEveryDay) dayStr = 'Every day';
      else if (isWeekdays) dayStr = 'Weekdays';
      else if (isWeekends) dayStr = 'Weekends';
      else dayStr = days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');

      return `${dayStr} at ${formatTime(schedule.time)}`;
    }
  }
}

/**
 * Format 24h time string to 12h format.
 */
function formatTime(time: string): string {
  const [hoursStr, minutesStr] = time.split(':');
  const hours = parseInt(hoursStr, 10);
  const minutes = minutesStr || '00';
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHours}:${minutes} ${ampm}`;
}
