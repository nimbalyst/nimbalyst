/**
 * Automation frontmatter types.
 *
 * Automations are markdown files with YAML frontmatter containing
 * an `automationStatus` block that defines scheduling and output config.
 */

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const ALL_DAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: 'M',
  tue: 'T',
  wed: 'W',
  thu: 'T',
  fri: 'F',
  sat: 'S',
  sun: 'S',
};

export const DAY_FULL_LABELS: Record<DayOfWeek, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export type ScheduleType = 'interval' | 'daily' | 'weekly';

export interface IntervalSchedule {
  type: 'interval';
  intervalMinutes: number;
}

export interface DailySchedule {
  type: 'daily';
  time: string; // "HH:MM" 24h format
}

export interface WeeklySchedule {
  type: 'weekly';
  days: DayOfWeek[];
  time: string; // "HH:MM" 24h format
}

export type AutomationSchedule = IntervalSchedule | DailySchedule | WeeklySchedule;

export type OutputMode = 'new-file' | 'append' | 'replace';

export type AutomationProvider = 'claude-code' | 'claude' | 'openai' | 'openai-codex';

export interface AutomationOutput {
  mode: OutputMode;
  /** Relative path from workspace root to output directory or file */
  location: string;
  /** Template for new-file mode. Supports {{date}}, {{time}}, {{id}} */
  fileNameTemplate?: string;
}

export interface AutomationStatus {
  id: string;
  title: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  output: AutomationOutput;
  provider?: AutomationProvider;
  /** Model ID to use (e.g. 'claude-code:opus', 'openai-codex:gpt-5.6-sol') */
  model?: string;
  lastRun?: string;
  lastRunStatus?: 'success' | 'error';
  lastRunError?: string;
  nextRun?: string;
  runCount: number;
}

/**
 * A single execution record stored in history.json.
 */
export interface ExecutionRecord {
  id: string;
  timestamp: string;
  durationMs: number;
  status: 'success' | 'error';
  error?: string;
  sessionId?: string;
  outputFile?: string;
}

/**
 * Default values for a new automation.
 */
export function createDefaultAutomationStatus(
  id: string = 'new-automation',
  title: string = 'New Automation',
): AutomationStatus {
  return {
    id,
    title,
    enabled: false,
    schedule: {
      type: 'daily',
      time: '09:00',
    },
    output: {
      mode: 'new-file',
      location: `nimbalyst-local/automations/${id}/`,
      fileNameTemplate: '{{date}}-output.md',
    },
    runCount: 0,
  };
}
