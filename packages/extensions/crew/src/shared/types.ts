/**
 * Crew panel <-> backend contract.
 *
 * Types only: this file is imported by the panel bundle and the backend
 * module alike, so it must never import Node or React. Timestamps are ISO 8601
 * strings.
 *
 * The panel talks to the backend through `callBackendTool(CREW_PANEL_TOOLS.x,
 * request)`. Those tools are panel-only: registered by the backend module but
 * never advertised to agents. Every response is plain JSON. A failed call
 * rejects with the backend's error message, which is written to be shown to
 * the user as-is.
 */

export const CREW_EXTENSION_ID = 'com.nimbalyst.crew';

/** The host namespaces backend tools as `<last id segment>.<tool name>`. */
export const CREW_TOOL_NAMESPACE = 'crew';

// ─── Definition ────────────────────────────────────────────────────────────

/** How loudly a member reaches the user. `ask` is the chapter's own AskUserQuestion. */
export type CrewLevel = 'note' | 'flag' | 'page' | 'ask';

export type CrewWeekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export interface CrewBudget {
  /** Rolling seven-day cap. The daily ceiling is derived as tokensPerWeek / 3, never stored. */
  tokensPerWeek: number;
  shiftsPerDay: number;
}

/**
 * One schedule entry in the definition file's frontmatter. Exactly one of
 * `daily`, `weekly`, `interval`, `at`. Local `HH:mm` times use the host time
 * zone; `at` is ISO 8601. `createdBy: 'member'` marks an entry the member
 * wrote for itself through its schedule tools.
 */
export type CrewScheduleSpec = {
  prompt: string;
  enabled?: boolean;
  createdBy?: 'user' | 'member';
} & (
  | { daily: string; weekly?: never; interval?: never; at?: never }
  | { weekly: { days: CrewWeekday[]; time: string }; daily?: never; interval?: never; at?: never }
  | { interval: { minutes: number }; daily?: never; weekly?: never; at?: never }
  | { at: string; daily?: never; weekly?: never; interval?: never }
);

/**
 * A parsed `nimbalyst-local/crew/<slug>.md`. `avatarPath` maps to frontmatter
 * `avatar`; `directive` is the markdown body; slug comes from the filename.
 */
export interface CrewMemberDefinition {
  slug: string;
  name: string;
  role: string;
  avatarPath?: string;
  color: string;
  provider: string;
  model: string;
  personality: string;
  directive: string;
  schedule: CrewScheduleSpec[];
  notify: { maxLevel: CrewLevel; quietHours?: string };
  budget: CrewBudget;
  paused?: boolean;
  /** Absolute path of the definition file. */
  sourcePath: string;
}

export type CrewMemberDraft = Omit<CrewMemberDefinition, 'sourcePath'>;

export interface CrewTemplate {
  id: string;
  name: string;
  role: string;
  description: string;
  personality: string;
  color: string;
  /** Fully resolved starter values, so the gallery needs no file reads. */
  definition: CrewMemberDraft;
}

// ─── Runtime state ─────────────────────────────────────────────────────────

export type CrewMemberStatus =
  | 'idle'
  | 'on-shift'
  | 'sleeping'
  | 'waiting-on-user'
  | 'over-budget'
  | 'paused'
  /** The definition file does not validate; see `runtime.errors`. */
  | 'error';

export type CrewShiftTrigger = 'user' | 'schedule' | 'self' | 'child-session' | 'launch-catchup';

/**
 * Where token numbers came from. `ledger`: Crew's own timestamped usage
 * ledger, exact for the window. `session-estimate`: a session older than the
 * ledger (for example after a damaged ledger file was set aside) was active in
 * the window, so the ledger may have missed some of its usage; each session
 * active in the window counts in full instead, which can over-count.
 */
export type CrewUsageSource = 'ledger' | 'session-estimate';

export interface CrewUsageSummary {
  /** Source of the weekly figure (the daily figure uses the ledger once it covers today). */
  source: CrewUsageSource;
  tokensThisWeek: number;
  tokensToday: number;
  tokensPerWeekLimit: number;
  dailyCeiling: number;
  shiftsToday: number;
  shiftsPerDayLimit: number;
  overBudget: boolean;
  /** Human-readable reasons when over budget ("today's shift limit reached"). */
  overBudgetReason?: string;
}

export interface CrewChapterRef {
  sessionId: string;
  chapterIndex: number;
  startedAt: string;
}

export interface CrewMemberRuntime {
  status: CrewMemberStatus;
  /** One line for the roster, e.g. "Sleeping until 18:30". */
  statusDetail: string;
  /** Validation errors for a member whose file does not parse; empty otherwise. */
  errors: string[];
  onShift: boolean;
  shiftStartedAt?: string;
  shiftTrigger?: CrewShiftTrigger;
  /**
   * Flags (any level) raised since the user last viewed this member's desk or
   * the feed, plus durable prompts waiting on the user in owned sessions,
   * queued prompts, and held inbox items.
   */
  unreadCount: number;
  /** Wakes held back (quiet hours, coalescing, budget) that the next shift will consume. */
  pendingInboxCount: number;
  nextRunAt?: string;
  lastRunAt?: string;
  /** The member's workstream container (all chapters are grouped under it). */
  workstreamId?: string;
  currentChapter?: CrewChapterRef;
  /**
   * True when the definition changed after the current chapter started. The
   * chapter's directive is frozen at its first turn, so edits to personality,
   * job, or model take effect when the next chapter starts. Show this.
   */
  definitionChangedSinceChapter: boolean;
  usage: CrewUsageSummary;
}

export interface CrewMemberSnapshot {
  definition: CrewMemberDefinition;
  runtime: CrewMemberRuntime;
}

export interface CrewUsageTotals {
  source: CrewUsageSource;
  tokensThisWeek: number;
  tokensPerWeekLimit: number;
  overBudget: boolean;
}

export interface CrewRosterSnapshot {
  members: CrewMemberSnapshot[];
  crewUsage: CrewUsageTotals;
  /** Whether every member is paused (the one-click "pause the crew"). */
  allPaused: boolean;
  /** Changes whenever backend state changes; poll and compare to skip re-renders. */
  revision: number;
  generatedAt: string;
}

export interface CrewChapterSummary extends CrewChapterRef {
  endedAt?: string;
  endReason?: string;
  handoffSummary?: string;
  isCurrent: boolean;
}

export interface CrewDelegatedSession {
  sessionId: string;
  name: string;
  /** The host's session status, passed through. */
  status: string;
  /** The owned session that spawned it (a chapter, or another delegated session). */
  parentSessionId?: string;
  createdAt?: string;
  hasPendingPrompt: boolean;
}

export interface CrewScheduleEntry {
  /** Position in the definition's schedule list; the key for edits. */
  index: number;
  spec: CrewScheduleSpec;
  nextRunAt?: string;
  /** Plain-language form, e.g. "Weekdays at 09:00". */
  description: string;
}

export interface CrewMemberDetail extends CrewMemberSnapshot {
  chapters: CrewChapterSummary[];
  delegated: CrewDelegatedSession[];
  schedule: CrewScheduleEntry[];
}

// ─── Feed (parsed from each member's journal.md) ──────────────────────────

export type CrewFeedKind =
  | 'shift'
  | 'flag'
  | 'journal'
  | 'handoff'
  | 'schedule-change'
  | 'budget'
  | 'system';

export type CrewEvidenceRef = { label?: string } & (
  | { kind: 'session'; sessionId: string }
  | { kind: 'tracker'; itemId: string; issueKey?: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'url'; url: string }
);

export interface CrewFeedEntry {
  /** Stable for a given journal entry: `<slug>:<at>:<ordinal>`. */
  id: string;
  memberSlug: string;
  at: string;
  kind: CrewFeedKind;
  title: string;
  body: string;
  /** For flags: the level actually delivered after the member's cap. */
  level?: Exclude<CrewLevel, 'ask'>;
  trigger?: CrewShiftTrigger;
  chapterIndex?: number;
  sessionId?: string;
  evidence?: CrewEvidenceRef[];
}

// ─── Panel-only tools ──────────────────────────────────────────────────────

/** Bare tool names; call them as `${CREW_TOOL_NAMESPACE}.${name}` (see `crewPanelToolName`). */
export const CREW_PANEL_TOOLS = {
  roster: 'panel_roster',
  member: 'panel_member',
  templates: 'panel_templates',
  hire: 'panel_hire',
  updateMember: 'panel_update_member',
  deleteMember: 'panel_delete_member',
  setPaused: 'panel_set_paused',
  setCrewPaused: 'panel_set_crew_paused',
  startShift: 'panel_start_shift',
  endShift: 'panel_end_shift',
  scheduleGet: 'panel_schedule_get',
  scheduleSet: 'panel_schedule_set',
  readMemory: 'panel_read_memory',
  writeNotes: 'panel_write_notes',
  feed: 'panel_feed',
  markSeen: 'panel_mark_seen',
} as const;

export type CrewPanelToolKey = keyof typeof CREW_PANEL_TOOLS;

export function crewPanelToolName(key: CrewPanelToolKey): string {
  return `${CREW_TOOL_NAMESPACE}.${CREW_PANEL_TOOLS[key]}`;
}

export type CrewRosterRequest = Record<string, never>;
export type CrewRosterResponse = CrewRosterSnapshot;

export interface CrewMemberRequest {
  slug: string;
}
export type CrewMemberResponse = CrewMemberDetail | null;

export type CrewTemplatesRequest = Record<string, never>;
export type CrewTemplatesResponse = CrewTemplate[];

/** `overrides` are applied on top of the template or the cloned member. */
export type CrewHireRequest =
  | { source: 'template'; templateId: string; slug?: string; overrides?: Partial<Omit<CrewMemberDraft, 'slug'>> }
  | { source: 'clone'; sourceSlug: string; slug: string; overrides?: Partial<Omit<CrewMemberDraft, 'slug'>> }
  | { source: 'draft'; definition: CrewMemberDraft };
export type CrewHireResponse = CrewMemberSnapshot;

export interface CrewUpdateMemberRequest extends CrewMemberRequest {
  /** Top-level patch; nested objects replace their previous value. Slugs are immutable. */
  changes: Partial<Omit<CrewMemberDraft, 'slug'>>;
}
export type CrewUpdateMemberResponse = CrewMemberSnapshot;

export type CrewDeleteMemberRequest = CrewMemberRequest;
/** Files are moved under `nimbalyst-local/crew/.deleted/`, never unlinked. Sessions are left alone. */
export interface CrewDeleteMemberResponse {
  archivedTo: string;
}

export interface CrewSetPausedRequest extends CrewMemberRequest {
  paused: boolean;
}
export type CrewSetPausedResponse = CrewMemberSnapshot;

export interface CrewSetCrewPausedRequest {
  paused: boolean;
}
export type CrewSetCrewPausedResponse = CrewRosterSnapshot;

export interface CrewStartShiftRequest extends CrewMemberRequest {
  /** What the user wants; omitted means "check in and do your job". */
  prompt?: string;
}
/**
 * `started`: a new shift began. `queued`: the member was already on shift and
 * the prompt was queued into the current chapter.
 */
export interface CrewStartShiftResponse {
  outcome: 'started' | 'queued';
  chapterSessionId: string;
  chapterIndex: number;
}

export type CrewEndShiftRequest = CrewMemberRequest;
/** Releases the member from its shift; a running turn is not interrupted. */
export interface CrewEndShiftResponse {
  ended: boolean;
}

export type CrewScheduleGetRequest = CrewMemberRequest;
export interface CrewScheduleGetResponse {
  entries: CrewScheduleEntry[];
  shiftsPerDay: number;
  quietHours?: string;
}

/** Replaces the whole schedule list; entries are attributed to the user unless marked. */
export interface CrewScheduleSetRequest extends CrewMemberRequest {
  schedule: CrewScheduleSpec[];
}
export type CrewScheduleSetResponse = CrewScheduleGetResponse;

export type CrewReadMemoryRequest = CrewMemberRequest;
export interface CrewReadMemoryResponse {
  notes: string;
  /** Content hash of `notes`, shown to the agent at chapter start; `expected` on save is the notes text itself. */
  notesRevision: string;
  journal: string;
}

export interface CrewWriteNotesRequest extends CrewMemberRequest {
  content: string;
  /** The notes text the edit was based on; the save is refused if the file changed since. */
  expected: string;
}
export interface CrewWriteNotesResponse {
  notesRevision: string;
}

export interface CrewFeedRequest {
  /** Omit for the crew-wide feed. */
  slug?: string;
  limit?: number;
  /** Exclusive ISO boundary; entries are returned newest first. */
  before?: string;
  kinds?: CrewFeedKind[];
}
export type CrewFeedResponse = CrewFeedEntry[];

/**
 * The user looked at a member's desk (`slug`) or the crew feed (no slug, all
 * members). Flags raised up to now stop counting toward `unreadCount`.
 */
export interface CrewMarkSeenRequest {
  slug?: string;
}
export interface CrewMarkSeenResponse {
  seenThrough: string;
}

/** Request/response pairs by panel tool, for a typed `callBackendTool` wrapper. */
export interface CrewPanelToolMap {
  roster: [CrewRosterRequest, CrewRosterResponse];
  member: [CrewMemberRequest, CrewMemberResponse];
  templates: [CrewTemplatesRequest, CrewTemplatesResponse];
  hire: [CrewHireRequest, CrewHireResponse];
  updateMember: [CrewUpdateMemberRequest, CrewUpdateMemberResponse];
  deleteMember: [CrewDeleteMemberRequest, CrewDeleteMemberResponse];
  setPaused: [CrewSetPausedRequest, CrewSetPausedResponse];
  setCrewPaused: [CrewSetCrewPausedRequest, CrewSetCrewPausedResponse];
  startShift: [CrewStartShiftRequest, CrewStartShiftResponse];
  endShift: [CrewEndShiftRequest, CrewEndShiftResponse];
  scheduleGet: [CrewScheduleGetRequest, CrewScheduleGetResponse];
  scheduleSet: [CrewScheduleSetRequest, CrewScheduleSetResponse];
  readMemory: [CrewReadMemoryRequest, CrewReadMemoryResponse];
  writeNotes: [CrewWriteNotesRequest, CrewWriteNotesResponse];
  feed: [CrewFeedRequest, CrewFeedResponse];
  markSeen: [CrewMarkSeenRequest, CrewMarkSeenResponse];
}

// ─── Agent tools (advertised to crew members' sessions) ───────────────────

/** Bare names; agents see them as `crew_flag`, `crew_journal_append`, ... */
export const CREW_AGENT_TOOLS = {
  flag: 'flag',
  journalAppend: 'journal_append',
  notesUpdate: 'notes_update',
  roster: 'roster',
  scheduleGet: 'schedule_get',
  scheduleSet: 'schedule_set',
  wakeMe: 'wake_me',
  /** The only agent tool open to every session: `/crew:hire` writes a new member with it. */
  hire: 'hire',
} as const;
