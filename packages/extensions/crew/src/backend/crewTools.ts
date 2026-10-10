/**
 * Crew's backend tools: the agent tools crew members call (advertised as
 * `crew_flag`, `crew_journal_append`, ...) and the panel-only tools the Crew
 * panel calls through `callBackendTool` (never advertised to agents).
 *
 * Agent tools act on "the member who called", resolved from the call
 * context's session owner. A session not owned by a crew member gets a clear
 * error instead of acting on some default member.
 */

import {
  CREW_AGENT_TOOLS,
  CREW_EXTENSION_ID,
  CREW_PANEL_TOOLS,
  type CrewEvidenceRef,
  type CrewFeedRequest,
  type CrewHireRequest,
  type CrewLevel,
  type CrewMemberDraft,
} from '../shared/types';
import { isValidCrewSlug } from './crewDefinition';
import type { CrewRuntime } from './crewRuntime';
import type { CrewService } from './crewService';
import type { ToolCallContext } from './hostSessions';

export interface CrewToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Callable from this extension's own panel only; hidden from agents. */
  panelOnly?: boolean;
  /** `owned-sessions`: listed only to sessions this extension owns (crew members and their delegated work). */
  audience?: 'all' | 'owned-sessions';
}

export type CrewToolHandler = (args: Record<string, unknown>, call?: ToolCallContext) => Promise<unknown>;

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const EVIDENCE_SCHEMA = {
  type: 'array',
  description: 'Links the user can click through: {kind:"session",sessionId} | {kind:"tracker",itemId,issueKey?} | {kind:"file",path,line?} | {kind:"url",url}, each with an optional label.',
  items: { type: 'object' },
};

const SCHEDULE_SCHEMA = {
  type: 'object',
  description: 'Exactly one of daily ("HH:mm"), weekly ({days:["monday",...], time:"HH:mm"}), interval ({minutes>=15}), or at (ISO time), plus prompt (what to do on that run).',
};

export const CREW_AGENT_TOOL_DESCRIPTORS: CrewToolDescriptor[] = [
  {
    name: CREW_AGENT_TOOLS.flag,
    description: 'Raise something to the user. Levels: note (crew feed only), flag (desktop notification), page (desktop and phone). Your maxLevel caps the level and quiet hours keep it in the feed. To ask a question, use AskUserQuestion instead. Every flag is recorded in your journal.',
    inputSchema: obj({
      level: { type: 'string', enum: ['note', 'flag', 'page'] },
      title: { type: 'string', description: 'One line.' },
      body: { type: 'string', description: 'What happened and what you want the user to do.' },
      evidence: EVIDENCE_SCHEMA,
    }, ['level', 'title', 'body']),
  },
  {
    name: CREW_AGENT_TOOLS.journalAppend,
    description: 'Add a mid-shift entry to your journal (nimbalyst-local/crew/<you>/journal.md). Your end-of-shift summary is journaled automatically; use this for things worth remembering before then.',
    inputSchema: obj({ title: { type: 'string' }, text: { type: 'string' } }, ['text']),
  },
  {
    name: CREW_AGENT_TOOLS.notesUpdate,
    description: 'Update your long-term notes, which every new chapter starts from. mode "append" adds a section. mode "replace" rewrites the whole file and needs the revision you read (from your chapter prompt or a previous call); it is refused if the user edited the notes since, so re-read and merge.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['append', 'replace'] },
      content: { type: 'string' },
      heading: { type: 'string', description: 'Section heading for append.' },
      revision: { type: 'string', description: 'Required for replace.' },
    }, ['mode', 'content']),
  },
  {
    name: CREW_AGENT_TOOLS.roster,
    description: 'List the crew: each member\'s name, role, status, and next run.',
    inputSchema: obj(),
  },
  {
    name: CREW_AGENT_TOOLS.scheduleGet,
    description: 'Read your schedule (with each entry\'s index and next run), your shifts-per-day limit, and your quiet hours.',
    inputSchema: obj(),
  },
  {
    name: CREW_AGENT_TOOLS.scheduleSet,
    description: 'Change your own schedule: add a run, replace (move) the entry at an index, or remove one. Refused if it would run inside quiet hours or exceed your shifts per day on any of the next seven days. Every change is shown to the user with your reason.',
    inputSchema: obj({
      action: { type: 'string', enum: ['add', 'replace', 'remove'] },
      index: { type: 'number', description: 'For replace and remove; from crew_schedule_get.' },
      schedule: SCHEDULE_SCHEMA,
      reason: { type: 'string', description: 'Why, in one sentence. Shown to the user.' },
    }, ['action', 'reason']),
  },
  {
    name: CREW_AGENT_TOOLS.wakeMe,
    description: 'Wake yourself once at a time ("check back at 15:00"). Sessions you delegated already wake you when they settle. Same bounds as crew_schedule_set.',
    inputSchema: obj({
      at: { type: 'string', description: 'ISO 8601 time.' },
      inMinutes: { type: 'number', description: 'Alternative to at.' },
      prompt: { type: 'string', description: 'What to do when you wake.' },
      reason: { type: 'string' },
    }, ['prompt', 'reason']),
  },
];

// Only crew members' own sessions (and their delegated work) see the agent tools.
for (const tool of CREW_AGENT_TOOL_DESCRIPTORS) tool.audience = tool.name === CREW_AGENT_TOOLS.roster ? 'all' : 'owned-sessions';

// Hiring happens from the user's own session (`/crew:hire`), so every session sees it.
CREW_AGENT_TOOL_DESCRIPTORS.push({
  name: CREW_AGENT_TOOLS.hire,
  description: 'Add a crew member by writing its definition file (nimbalyst-local/crew/<slug>.md). Pass the whole file: YAML frontmatter under a `crew:` key, then the job instructions as the markdown body. Confirm the draft with the user first. If it does not validate, the error names each bad field; fix those and call again.',
  inputSchema: obj({
    definition: { type: 'string', description: 'The complete definition file, starting with `---`.' },
    slug: { type: 'string', description: 'Optional file name (lowercase letters, digits, dashes). Defaults to one derived from crew.name.' },
  }, ['definition']),
  audience: 'all',
});

export const CREW_PANEL_TOOL_DESCRIPTORS: CrewToolDescriptor[] = Object.values(CREW_PANEL_TOOLS).map((name) => ({
  name,
  description: `Crew panel operation ${name}.`,
  inputSchema: obj(),
  panelOnly: true,
}));

/** The crew member a tool call came from. Delegated sessions act for the member that owns them. */
export function callerSlug(call: ToolCallContext | undefined): string {
  const owner = call?.sessionOwner;
  if (!owner || owner.extensionId !== CREW_EXTENSION_ID || !isValidCrewSlug(owner.key)) {
    throw new Error('Crew tools only work inside a crew member\'s sessions, and this session does not belong to a crew member.');
  }
  return owner.key;
}

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${key} must be text`);
  return value;
}

function slugArg(args: Record<string, unknown>): string {
  const slug = str(args, 'slug', true)!;
  if (!isValidCrewSlug(slug)) throw new Error(`Invalid crew member slug "${slug}"`);
  return slug;
}

export function createCrewToolHandlers(runtime: CrewRuntime, service: CrewService): Record<string, CrewToolHandler> {
  const agent: Record<string, CrewToolHandler> = {
    [CREW_AGENT_TOOLS.flag]: async (args, call) => {
      const definition = await service.requireMember(callerSlug(call));
      return runtime.flag(definition, {
        level: str(args, 'level', true) as CrewLevel,
        title: str(args, 'title', true)!,
        body: str(args, 'body') ?? '',
        ...(Array.isArray(args.evidence) ? { evidence: args.evidence as CrewEvidenceRef[] } : {}),
      }, call?.sessionId ?? undefined);
    },
    [CREW_AGENT_TOOLS.journalAppend]: async (args, call) => {
      const slug = callerSlug(call);
      await service.requireMember(slug);
      await runtime.journal(slug, {
        kind: 'journal',
        title: str(args, 'title') ?? 'Journal',
        body: str(args, 'text', true)!,
        ...(call?.sessionId ? { sessionId: call.sessionId } : {}),
      });
      return { ok: true };
    },
    [CREW_AGENT_TOOLS.notesUpdate]: async (args, call) => {
      const slug = callerSlug(call);
      await service.requireMember(slug);
      const mode = str(args, 'mode', true);
      if (mode !== 'append' && mode !== 'replace') throw new Error('mode must be append or replace');
      return service.updateNotesByMember(slug, {
        mode,
        content: str(args, 'content', true)!,
        ...(str(args, 'heading') ? { heading: str(args, 'heading') } : {}),
        ...(str(args, 'revision') ? { revision: str(args, 'revision') } : {}),
      });
    },
    [CREW_AGENT_TOOLS.roster]: async (_args, call) => {
      // Read-only, so any session may call it (a hiring session checks for duplicate roles); `you` is only set for a crew caller.
      const owner = call?.sessionOwner;
      const self = owner?.extensionId === CREW_EXTENSION_ID ? owner.key : undefined;
      const roster = await service.roster();
      return {
        members: roster.members.map(({ definition, runtime: state }) => ({
          slug: definition.slug,
          name: definition.name,
          role: definition.role,
          status: state.statusDetail,
          ...(state.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
          ...(definition.slug === self ? { you: true } : {}),
        })),
      };
    },
    [CREW_AGENT_TOOLS.scheduleGet]: async (_args, call) => service.schedule(callerSlug(call)),
    [CREW_AGENT_TOOLS.scheduleSet]: async (args, call) => {
      const definition = await service.requireMember(callerSlug(call));
      const action = str(args, 'action', true);
      const reason = str(args, 'reason', true)!;
      const index = typeof args.index === 'number' ? args.index : NaN;
      if (action === 'add') await runtime.setScheduleByMember(definition, { action, schedule: args.schedule, reason });
      else if (action === 'replace') await runtime.setScheduleByMember(definition, { action, index, schedule: args.schedule, reason });
      else if (action === 'remove') await runtime.setScheduleByMember(definition, { action, index, reason });
      else throw new Error('action must be add, replace, or remove');
      return service.schedule(definition.slug);
    },
    [CREW_AGENT_TOOLS.wakeMe]: async (args, call) => {
      const definition = await service.requireMember(callerSlug(call));
      const minutes = typeof args.inMinutes === 'number' ? args.inMinutes : undefined;
      const atText = str(args, 'at');
      let atMs: number;
      if (atText) atMs = Date.parse(atText);
      else if (minutes !== undefined && minutes > 0) atMs = runtime.now() + minutes * 60_000;
      else throw new Error('Give at (ISO time) or inMinutes');
      if (!Number.isFinite(atMs)) throw new Error(`"${atText}" is not a valid time`);
      await runtime.setScheduleByMember(definition, {
        action: 'add',
        schedule: { at: new Date(atMs).toISOString(), prompt: str(args, 'prompt', true) },
        reason: str(args, 'reason', true)!,
      });
      return { ok: true, wakeAt: new Date(atMs).toISOString() };
    },
    [CREW_AGENT_TOOLS.hire]: async (args) => {
      const { definition } = await service.hireFromFile(str(args, 'definition', true)!, str(args, 'slug'));
      return {
        slug: definition.slug,
        name: definition.name,
        role: definition.role,
        path: `nimbalyst-local/crew/${definition.slug}.md`,
        paused: definition.paused === true,
      };
    },
  };

  const panel: Record<string, CrewToolHandler> = {
    [CREW_PANEL_TOOLS.roster]: async () => service.roster(),
    [CREW_PANEL_TOOLS.member]: async (args) => service.member(slugArg(args)),
    [CREW_PANEL_TOOLS.templates]: async () => service.templates(),
    [CREW_PANEL_TOOLS.hire]: async (args) => service.hire(args as unknown as CrewHireRequest),
    [CREW_PANEL_TOOLS.updateMember]: async (args) =>
      service.update(slugArg(args), (args.changes ?? {}) as Partial<Omit<CrewMemberDraft, 'slug'>>),
    [CREW_PANEL_TOOLS.deleteMember]: async (args) => service.remove(slugArg(args)),
    [CREW_PANEL_TOOLS.setPaused]: async (args) => service.setPaused(slugArg(args), args.paused === true),
    [CREW_PANEL_TOOLS.setCrewPaused]: async (args) => service.setCrewPaused(args.paused === true),
    [CREW_PANEL_TOOLS.startShift]: async (args) => runtime.startShift(slugArg(args), str(args, 'prompt')),
    [CREW_PANEL_TOOLS.endShift]: async (args) => ({ ended: await runtime.endShift(slugArg(args)) }),
    [CREW_PANEL_TOOLS.scheduleGet]: async (args) => service.schedule(slugArg(args)),
    [CREW_PANEL_TOOLS.scheduleSet]: async (args) => {
      const slug = slugArg(args);
      if (!Array.isArray(args.schedule)) throw new Error('schedule must be a list');
      await runtime.setScheduleByUser(slug, args.schedule);
      return service.schedule(slug);
    },
    [CREW_PANEL_TOOLS.readMemory]: async (args) => service.readMemory(slugArg(args)),
    [CREW_PANEL_TOOLS.writeNotes]: async (args) =>
      service.writeNotesByUser(slugArg(args), str(args, 'content') ?? '', typeof args.expected === 'string' ? args.expected : ''),
    [CREW_PANEL_TOOLS.feed]: async (args) => service.feed(args as CrewFeedRequest),
    [CREW_PANEL_TOOLS.markSeen]: async (args) => {
      const slug = args.slug === undefined || args.slug === null || args.slug === '' ? undefined : slugArg(args);
      return { seenThrough: new Date(await runtime.markSeen(slug)).toISOString() };
    },
  };

  return { ...agent, ...panel };
}
