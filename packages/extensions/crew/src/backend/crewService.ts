/**
 * Member-level operations behind the panel and agent tools: roster
 * snapshots, hiring, editing, pausing, notes, and the feed. Scheduling and
 * shifts live in CrewRuntime; this layer composes files + runtime state into
 * the shapes in shared/types.ts.
 */

import type {
  CrewFeedRequest,
  CrewFeedEntry,
  CrewHireRequest,
  CrewMemberDefinition,
  CrewMemberDetail,
  CrewMemberDraft,
  CrewMemberSnapshot,
  CrewRosterSnapshot,
  CrewScheduleGetResponse,
  CrewTemplate,
  CrewUsageSummary,
} from '../shared/types';
import {
  crewDefinitionPath,
  isValidCrewSlug,
  parseCrewMemberFile,
  serializeCrewMember,
  slugFromName,
  splitCrewFile,
} from './crewDefinition';
import * as crewFiles from './crewFiles';
import { CREW_TEMPLATES, getCrewTemplate } from './crewTemplates';
import { buildUsageSummary, deriveMemberStatus, formatLocalStamp } from './crewPolicy';
import { definitionHash } from './crewDirective';
import { chapterSummaries, delegatedSummaries, type MemberSessions } from './crewChapters';
import { mergeFeeds, parseJournalFeed } from './crewJournal';
import type { CrewRuntime } from './crewRuntime';

const ROSTER_RECONCILE_MS = 60_000;

const EMPTY_SESSIONS: MemberSessions = { chapters: [], delegated: [], lastRunAtMs: null, shiftStartsMs: [] };

export class CrewService {
  private fileFingerprint: string | undefined;

  constructor(private readonly runtime: CrewRuntime) {}

  private get workspacePath(): string {
    return this.runtime.workspacePath;
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────

  async roster(): Promise<CrewRosterSnapshot> {
    // Budgets shown here must include usage the ledger has not heard about yet;
    // throttled because the panel polls the roster.
    await this.runtime.reconcileUsage({ maxAgeMs: ROSTER_RECONCILE_MS }).catch(() => undefined);
    const loaded = await crewFiles.loadCrewMembers(this.workspacePath);
    await this.noticeFileEdits(loaded);
    const members = await Promise.all(loaded.map((member) => this.snapshot(member)));
    const crew = await this.runtime.crewTokensWeek();
    const tokensThisWeek = crew.tokens;
    const limit = this.runtime.crewTokensPerWeek();
    const valid = members.filter((member) => member.runtime.errors.length === 0);
    return {
      members,
      crewUsage: { source: crew.source, tokensThisWeek, tokensPerWeekLimit: limit, overBudget: tokensThisWeek >= limit },
      allPaused: valid.length > 0 && valid.every((member) => member.definition.paused === true),
      revision: this.runtime.revision,
      generatedAt: new Date(this.runtime.now()).toISOString(),
    };
  }

  /**
   * Definition, notes, and journal files can be edited by hand. The panel only
   * re-renders when `revision` moves, so a change in what those files hold
   * bumps it just like a change made through Crew.
   */
  private async noticeFileEdits(loaded: crewFiles.LoadedCrewMember[]): Promise<void> {
    const parts = await Promise.all(loaded.map(async (member) => ({
      slug: member.slug,
      definition: member.definition,
      errors: member.errors,
      memory: await crewFiles.memoryFileStamps(this.workspacePath, member.slug).catch(() => null),
    })));
    const fingerprint = JSON.stringify(parts);
    if (this.fileFingerprint !== undefined && fingerprint !== this.fileFingerprint) this.runtime.bump();
    this.fileFingerprint = fingerprint;
  }

  async member(slug: string): Promise<CrewMemberDetail | null> {
    const loaded = await crewFiles.loadCrewMember(this.workspacePath, slug);
    if (!loaded) return null;
    const sessions = loaded.errors.length > 0 ? EMPTY_SESSIONS : await this.runtime.memberSessions(slug);
    const snapshot = await this.snapshot(loaded, sessions);
    return {
      ...snapshot,
      chapters: chapterSummaries(sessions),
      delegated: delegatedSummaries(sessions),
      schedule: this.runtime.scheduleEntries(loaded.definition, sessions.lastRunAtMs),
    };
  }

  async requireMember(slug: string): Promise<CrewMemberDefinition> {
    const loaded = await crewFiles.loadCrewMember(this.workspacePath, slug);
    if (!loaded) throw new Error(`Crew member "${slug}" not found`);
    if (loaded.errors.length > 0) throw new Error(`${slug}.md has errors: ${loaded.errors.join('; ')}`);
    return loaded.definition;
  }

  private async snapshot(loaded: crewFiles.LoadedCrewMember, known?: MemberSessions): Promise<CrewMemberSnapshot> {
    const { definition, errors } = loaded;
    const now = this.runtime.now();
    const timeZone = this.runtime.timeZone();
    const sessions = known ?? (errors.length > 0 ? EMPTY_SESSIONS : await this.runtime.memberSessions(loaded.slug));
    const state = this.runtime.memberState(loaded.slug);
    let usage: CrewUsageSummary;
    if (errors.length > 0) {
      usage = {
        source: 'ledger', tokensThisWeek: 0, tokensToday: 0, tokensPerWeekLimit: definition.budget.tokensPerWeek,
        dailyCeiling: Math.floor(definition.budget.tokensPerWeek / 3), shiftsToday: 0,
        shiftsPerDayLimit: definition.budget.shiftsPerDay, overBudget: false,
      };
    } else {
      const { input, verdict, source } = await this.runtime.usage(definition, sessions);
      usage = buildUsageSummary(input, verdict, source);
    }
    const current = sessions.current;
    const owned = [...sessions.chapters.map((chapter) => chapter.session), ...sessions.delegated];
    const durablePrompts = owned.filter((session) => session.hasPendingPrompt).length;
    const queued = current?.session.queuedPromptCount ?? 0;
    const seenThroughMs = this.runtime.seenThroughMs(loaded.slug);
    const unseenFlags = parseJournalFeed(loaded.slug, await crewFiles.readJournal(this.workspacePath, loaded.slug).catch(() => ''))
      .filter((entry) => entry.kind === 'flag' && Date.parse(entry.at) > seenThroughMs).length;
    const waitingOnUser = state.waitingOnUser || current?.session.hasPendingPrompt === true;
    // A chapter running outside a Crew-started shift is the user talking to it from the desk.
    const onShift = state.onShift || current?.session.status === 'running';
    const nextRunAtMs = definition.paused || errors.length > 0 ? null : this.runtime.nextRunAtMs(definition, sessions.lastRunAtMs);
    const status = deriveMemberStatus({
      definitionErrors: errors,
      paused: definition.paused === true,
      onShift,
      waitingOnUser,
      overBudget: usage.overBudget,
      nextRunAtMs,
      nowMs: now,
      timeZone,
    });
    const frozenHash = current?.meta.definitionHash;
    return {
      definition,
      runtime: {
        status: status.status,
        statusDetail: status.detail,
        errors,
        onShift,
        ...(state.shiftStartedAtMs !== undefined ? { shiftStartedAt: new Date(state.shiftStartedAtMs).toISOString() } : {}),
        ...(state.shiftTrigger ? { shiftTrigger: state.shiftTrigger } : {}),
        unreadCount: unseenFlags + durablePrompts + queued + state.heldCount,
        pendingInboxCount: state.heldCount,
        ...(nextRunAtMs !== null ? { nextRunAt: new Date(nextRunAtMs).toISOString() } : {}),
        ...(sessions.lastRunAtMs !== null ? { lastRunAt: new Date(sessions.lastRunAtMs).toISOString() } : {}),
        ...(sessions.workstreamId ? { workstreamId: sessions.workstreamId } : {}),
        ...(current
          ? { currentChapter: { sessionId: current.session.sessionId, chapterIndex: current.meta.chapterIndex, startedAt: current.meta.startedAt } }
          : {}),
        definitionChangedSinceChapter: frozenHash !== undefined && errors.length === 0 && frozenHash !== definitionHash(definition),
        usage,
      },
    };
  }

  // ─── Hiring and editing ────────────────────────────────────────────────

  templates(): CrewTemplate[] {
    return structuredClone([...CREW_TEMPLATES]);
  }

  async hire(request: CrewHireRequest): Promise<CrewMemberSnapshot> {
    let draft: CrewMemberDraft;
    if (request.source === 'template') {
      const template = getCrewTemplate(request.templateId);
      if (!template) throw new Error(`Unknown crew template "${request.templateId}"`);
      const slug = request.slug ?? (await this.freeSlug(template.definition.slug));
      draft = { ...template.definition, ...request.overrides, slug };
    } else if (request.source === 'clone') {
      const source = await this.requireMember(request.sourceSlug);
      const { sourcePath: _sourcePath, ...rest } = source;
      void _sourcePath;
      draft = { ...rest, ...request.overrides, slug: request.slug, paused: false };
    } else {
      draft = request.definition;
    }
    this.validateDraft(draft);
    await crewFiles.createCrewMemberFiles(this.workspacePath, draft);
    await this.runtime.journal(draft.slug, {
      kind: 'system',
      title: 'Hired',
      body: `${draft.name} joined the crew as ${draft.role}.`,
    });
    await this.runtime.onDefinitionsChanged();
    const loaded = await crewFiles.loadCrewMember(this.workspacePath, draft.slug);
    return this.snapshot(loaded!);
  }

  async update(slug: string, changes: Partial<Omit<CrewMemberDraft, 'slug'>>): Promise<CrewMemberSnapshot> {
    await crewFiles.updateCrewMemberFile(this.workspacePath, slug, (current) => {
      const { sourcePath: _sourcePath, ...rest } = current;
      void _sourcePath;
      const next: CrewMemberDraft = { ...rest, ...changes, slug };
      this.validateDraft(next);
      return next;
    });
    await this.runtime.onDefinitionsChanged();
    const loaded = await crewFiles.loadCrewMember(this.workspacePath, slug);
    return this.snapshot(loaded!);
  }

  async remove(slug: string): Promise<{ archivedTo: string }> {
    if (!isValidCrewSlug(slug)) throw new Error(`Invalid crew member slug "${slug}"`);
    await this.runtime.endShift(slug).catch(() => false);
    const archivedTo = await crewFiles.archiveCrewMemberFiles(this.workspacePath, slug, this.runtime.now());
    await this.runtime.onDefinitionsChanged();
    return { archivedTo };
  }

  async setPaused(slug: string, paused: boolean): Promise<CrewMemberSnapshot> {
    return this.update(slug, { paused });
  }

  async setCrewPaused(paused: boolean): Promise<CrewRosterSnapshot> {
    const members = await crewFiles.loadCrewMembers(this.workspacePath);
    for (const member of members) {
      if (member.errors.length > 0 || (member.definition.paused === true) === paused) continue;
      await crewFiles.updateCrewMemberFile(this.workspacePath, member.slug, (current) => {
        const { sourcePath: _sourcePath, ...rest } = current;
        void _sourcePath;
        return { ...rest, paused };
      });
    }
    await this.runtime.onDefinitionsChanged();
    return this.roster();
  }

  /**
   * `/crew:hire`: an agent in an ordinary session interviews the user, then
   * hands the whole definition file here. Validation errors are thrown with
   * their frontmatter paths so the agent can fix the file and call again.
   */
  async hireFromFile(text: string, requestedSlug?: string): Promise<CrewMemberSnapshot> {
    const file = unfenceDefinition(text);
    let name: unknown;
    try {
      name = (splitCrewFile(file).frontmatter as { crew?: { name?: unknown } } | undefined)?.crew?.name;
    } catch {
      name = undefined;
    }
    let slug: string;
    if (requestedSlug) {
      if (!isValidCrewSlug(requestedSlug)) throw new Error(`"${requestedSlug}" is not a valid slug: use lowercase letters, digits, and dashes`);
      if (await crewFiles.loadCrewMember(this.workspacePath, requestedSlug)) throw new Error(`A crew member named "${requestedSlug}" already exists; pick another slug`);
      slug = requestedSlug;
    } else {
      slug = await this.freeSlug((typeof name === 'string' && slugFromName(name)) || 'member');
    }
    const parsed = parseCrewMemberFile(slug, crewDefinitionPath(this.workspacePath, slug), `${file}\n`);
    if (!parsed.ok) {
      throw new Error(`The definition did not validate: ${parsed.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
    }
    const { sourcePath: _sourcePath, ...definition } = parsed.definition;
    void _sourcePath;
    return this.hire({ source: 'draft', definition });
  }

  private validateDraft(draft: CrewMemberDraft): void {
    if (!isValidCrewSlug(draft.slug)) throw new Error(`"${draft.slug}" is not a valid slug: use lowercase letters, digits, and dashes`);
    const sourcePath = crewDefinitionPath(this.workspacePath, draft.slug);
    const parsed = parseCrewMemberFile(draft.slug, sourcePath, serializeCrewMember(draft));
    if (!parsed.ok) {
      throw new Error(`Invalid crew member: ${parsed.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
    }
  }

  private async freeSlug(base: string): Promise<string> {
    for (let n = 1; n < 100; n += 1) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (!(await crewFiles.loadCrewMember(this.workspacePath, slug))) return slug;
    }
    throw new Error(`No free slug for "${base}"`);
  }

  // ─── Schedule, memory, feed ────────────────────────────────────────────

  async schedule(slug: string): Promise<CrewScheduleGetResponse> {
    const definition = await this.requireMember(slug);
    const sessions = await this.runtime.memberSessions(slug);
    return {
      entries: this.runtime.scheduleEntries(definition, sessions.lastRunAtMs),
      shiftsPerDay: definition.budget.shiftsPerDay,
      ...(definition.notify.quietHours ? { quietHours: definition.notify.quietHours } : {}),
    };
  }

  async readMemory(slug: string): Promise<{ notes: string; notesRevision: string; journal: string }> {
    if (!isValidCrewSlug(slug)) throw new Error(`Invalid crew member slug "${slug}"`);
    const notes = await crewFiles.readNotes(this.workspacePath, slug);
    return { notes, notesRevision: crewFiles.notesRevision(notes), journal: await crewFiles.readJournal(this.workspacePath, slug) };
  }

  /** The user's edit: refused if the notes changed since `expected` was read. */
  async writeNotesByUser(slug: string, content: string, expected: string): Promise<{ notesRevision: string }> {
    await this.requireMember(slug);
    await crewFiles.replaceNotes(this.workspacePath, slug, content, { content: expected });
    this.runtime.bump();
    return { notesRevision: crewFiles.notesRevision(content) };
  }

  /** The member's edit: append a section, or replace based on a revision it read. */
  async updateNotesByMember(
    slug: string,
    input: { mode: 'append' | 'replace'; content: string; heading?: string; revision?: string },
  ): Promise<{ notesRevision: string }> {
    if (!input.content?.trim()) throw new Error('content is required');
    if (input.mode === 'append') {
      await crewFiles.appendNotesSection(this.workspacePath, slug, {
        heading: input.heading?.trim() || `Note (${formatLocalStamp(this.runtime.now(), this.runtime.timeZone())})`,
        body: input.content,
      });
    } else {
      if (!input.revision) {
        throw new Error('Replacing notes needs the revision you read (shown in your chapter prompt, or from a previous crew_notes_update). Use mode "append" to add without it.');
      }
      try {
        await crewFiles.replaceNotes(this.workspacePath, slug, input.content, { revision: input.revision });
      } catch (error) {
        if (error instanceof crewFiles.CrewFileConflictError) {
          const current = await crewFiles.readNotes(this.workspacePath, slug);
          throw new Error(`Your notes changed since revision ${input.revision} (the user may have corrected them). Current revision: ${crewFiles.notesRevision(current)}. Re-read ${slug}/notes.md and merge before replacing.`);
        }
        throw error;
      }
    }
    this.runtime.bump();
    return { notesRevision: crewFiles.notesRevision(await crewFiles.readNotes(this.workspacePath, slug)) };
  }

  async feed(request: CrewFeedRequest): Promise<CrewFeedEntry[]> {
    const slugs = request.slug
      ? [request.slug]
      : (await crewFiles.loadCrewMembers(this.workspacePath)).map((member) => member.slug);
    const feeds = await Promise.all(
      slugs.filter(isValidCrewSlug).map(async (slug) => parseJournalFeed(slug, await crewFiles.readJournal(this.workspacePath, slug))),
    );
    return mergeFeeds(feeds, request);
  }
}

/** Agents often wrap the file in a code fence; the file itself starts at `---`. */
function unfenceDefinition(text: string): string {
  const fenced = /^\s*```[a-z]*\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}
