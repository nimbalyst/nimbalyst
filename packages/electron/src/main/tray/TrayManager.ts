import { warnIfUnpublished } from '@nimbalyst/runtime/sync/pushOutcome';
/**
 * TrayManager - System tray icon and menu for AI session status
 *
 * Provides at-a-glance visibility into AI session state from the macOS menu bar.
 * Subscribes to SessionStateManager events for real-time updates and listens
 * to prompt events from AIService for blocked state detection.
 *
 * Icon states (priority order): Error > Needs Attention > Running > Idle
 */

import path from 'node:path';
import { Tray, Menu, app, nativeImage, nativeTheme, systemPreferences, BrowserWindow } from 'electron';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { findWindowByWorkspace } from '../window/WindowManager';
import { getPackageRoot } from '../utils/appPaths';
import {
  isShowTrayIcon,
  setShowTrayIcon,
  isShowTrayStrip,
  setShowTrayStrip,
  getTrayStripStyle,
  setTrayStripStyle,
  type TrayStripStyle,
  getSessionSyncConfig,
  setSessionSyncConfig,
  isOSNotificationsEnabled,
  setOSNotificationsEnabled,
} from '../utils/store';
import { logger } from '../utils/logger';
import { isPreventingSleep, getSleepPreventionMode } from '../services/PowerSaveService';
import { updateSleepPrevention, resolvePreventSleepMode, getSyncProvider } from '../services/SyncManager';
import {
  closeTrayPanelWindow,
  isTrayPanelSupported,
  isTrayPanelWindow,
  pushTrayPanelFeed,
  toggleTrayPanelWindow,
} from '../window/TrayPanelWindow';
import {
  emptyTrayPanelFeed,
  type TrayIdleSummary,
  type TrayPanelFeed,
  type TrayPanelSession,
} from '../../shared/traySessions';
import type {
  MenuBarIslandSettingChange,
  MenuBarIslandSettings,
} from '../../shared/menuBarIsland';
import {
  deriveFleetSnapshot,
  isStalled,
  type FleetSnapshot,
  type PromptKind,
  type TraySessionInfo,
} from './fleetSnapshot';
import { buildFleetActivityPayload } from './fleetActivity';
import { FleetActivityPublisher } from './fleetActivityPublisher';
import { isFleetActivityAvailable, sendFleetActivity } from '../services/ai/fleetActivityPush';
import { isIdleView, StripStateMachine, stripViewKey, type StripView } from './stripStateMachine';
import { TrayStripRenderer } from './TrayStripRenderer';
import { ISLAND_STRIP_KEY, toIslandStrip } from './islandStrip';
import { latestAssistantTextSql, sessionTitlesSql, toSnippetLine } from './sessionSnippets';
import { unreadSeedQuery } from './unreadSeedQuery';
import {
  closeMenuBarIsland,
  isMenuBarIslandSupported,
  isMenuBarIslandWindow,
  showMenuBarIsland,
} from '../window/MenuBarIslandWindow';

export type { TraySessionInfo, PromptKind } from './fleetSnapshot';

// ─── Types ──────────────────────────────────────────────────────────────────

type TrayIconState = 'idle' | 'running' | 'attention' | 'error';

// ─── Database interface (same as SessionStateManager) ───────────────────────

interface DatabaseWorker {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

interface TrayUnreadClearPayload {
  sessions: Array<{
    sessionId: string;
    workspacePath: string;
    lastReadAt: number;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MENU_REBUILD_DEBOUNCE_MS = 300;
const COMPLETED_LINGER_MS = 60_000; // Keep completed sessions visible for 1 minute
/**
 * How many already-unread sessions to restore from the database at launch.
 *
 * A cap rather than the whole set. Nothing clears the unread flag on a session
 * the user never opens, so it accumulates without bound -- a real install had
 * 427 of them -- and the tray menu and the island panel are both lists someone
 * is meant to work through. `seedUnreadFromDatabase` takes the newest.
 */
const UNREAD_SEED_LIMIT = 25;
/**
 * The strip's age is rounded to minutes, so it only needs redrawing that often.
 * A ticking second counter would be 60x the captures to say the same thing.
 */
const STRIP_AGE_TICK_MS = 60_000;
/** How many sessions the idle panel offers to reopen. Enough to recognise one. */
const RECENT_SESSIONS_LIMIT = 5;
/** Idle repaints every minute; this answer does not change nearly that often. */
const RECENT_SESSIONS_TTL_MS = 5 * 60_000;

/**
 * Project windows only.
 *
 * The tray panel and the menu bar island are BrowserWindows too, so they appear
 * in `getAllWindows()`. Focusing one in response to "Open Nimbalyst" would be a
 * no-op from the user's point of view, and counting it as a visible foreground
 * window makes the app look focused whenever it is on screen -- which for the
 * island is always.
 */
function projectWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed()
      && !isTrayPanelWindow(window)
      && !isMenuBarIslandWindow(window),
  );
}

// ─── Row helpers ────────────────────────────────────────────────────────────

/**
 * Read the whole `metadata` column rather than sub-extracting keys in SQL:
 * `data->'key'` yields a parsed object on PGLite but a JSON string on SQLite,
 * and both backends are live. See packages/electron/DATABASE.md.
 */
function parseMetadataColumn(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) ?? {};
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

/** `updated_at` arrives as a Date on PGLite and an ISO string or epoch on SQLite. */
function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

// ─── Grouping ───────────────────────────────────────────────────────────────

function toPanelSession(session: TraySessionInfo, hasPendingPrompt: boolean): TrayPanelSession {
  return {
    sessionId: session.sessionId,
    title: session.title || 'Untitled Session',
    workspacePath: session.workspacePath,
    workspaceName: session.workspacePath ? path.basename(session.workspacePath) : '',
    provider: session.provider || 'claude',
    ...(session.model ? { model: session.model } : {}),
    updatedAt: session.updatedAt ?? session.completedAt ?? 0,
    isStreaming: session.isStreaming,
    hasPendingPrompt,
    hasError: session.status === 'error',
  };
}

/**
 * Classify cached sessions into the three attention buckets.
 *
 * Deliberately mirrors `agentSessionAttentionAtom` in the renderer: archived
 * sessions are excluded, `phase === 'complete'` only suppresses the running
 * bucket (an agent sets that phase just before its closing output, so it must
 * not hide an unread or prompting session), and each session lands in exactly
 * one bucket by priority. It diverges in two intended ways — the scope is every
 * workspace (the menu bar is global), and `status === 'error'` counts as needing
 * attention, which the in-app popover has no equivalent for.
 *
 * `hasPendingPrompt` is kept in step with the persisted bit by
 * `setSessionPendingPrompt`, which notifies this class as it writes -- see the
 * header of pendingPromptPersistence.ts for why that is a single call.
 *
 * Exported as a free function so the grouping is testable without the singleton.
 */
/**
 * `now` is required for the same reason `deriveFleetSnapshot`'s is: the stalled
 * bucket is clock-dependent, and a defaulted `Date.now()` would let a fixture
 * pinned to a fixed timestamp be measured against the real wall clock.
 */
export function groupTraySessions(
  sessions: Iterable<TraySessionInfo>,
  now: number,
): TrayPanelFeed {
  const feed = emptyTrayPanelFeed();

  const visible = Array.from(sessions)
    .filter((session) => !session.isArchived)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  for (const session of visible) {
    if (session.hasPendingPrompt || session.status === 'error') {
      feed.needsAttention.push(toPanelSession(session, session.hasPendingPrompt));
    } else if (session.status === 'running') {
      if (session.phase !== 'complete') {
        // The same `isStalled` the snapshot uses, not a second copy of the
        // rule: the panel is the sentence form of the strip, so the two must
        // not be able to disagree about which sessions have gone quiet. Both
        // callers are handed a clock rather than reading one, so both are
        // testable without faking time.
        const bucket = isStalled(session, now) ? feed.stalled : feed.running;
        bucket.push(toPanelSession(session, false));
      }
    } else if (session.hasUnread) {
      feed.unread.push(toPanelSession(session, false));
    }
  }

  return feed;
}

// ─── TrayManager ────────────────────────────────────────────────────────────

export class TrayManager {
  private static instance: TrayManager;

  private tray: Tray | null = null;
  private sessionCache: Map<string, TraySessionInfo> = new Map();
  private stateUnsubscribe: (() => void) | null = null;
  private menuRebuildTimer: NodeJS.Timeout | null = null;
  private lingerTimers: Map<string, NodeJS.Timeout> = new Map();
  private database: DatabaseWorker | null = null;
  private themeListener: (() => void) | null = null;

  // ─── Menu bar strip ───────────────────────────────────────────────────
  private stripMachine = new StripStateMachine();
  private stripRenderer: TrayStripRenderer | null = null;
  private stripHoldTimer: NodeJS.Timeout | null = null;
  private stripAgeTimer: NodeJS.Timeout | null = null;
  private lastStripKey: string | null = null;
  /** Session the strip is currently naming; clicking the strip goes straight to it. */
  private namedSessionId: { sessionId: string; workspacePath: string } | null = null;
  /** Monotonic, so a renderer can drop a snapshot that arrives out of order. */
  private snapshotRevision = 0;
  /**
   * Newest activity anywhere, surviving cache eviction.
   *
   * Completed sessions leave the cache after a minute, so the cache cannot
   * answer "how long has it been quiet". Seeded from the database at startup so
   * a fresh launch reports a real age instead of claiming everything just
   * happened.
   *
   * This used to drive the strip's quiet age, which is exactly what it should
   * not have done: an unlabeled duration in the strip's actionable slot, whose
   * value on a fresh launch was a `MAX(updated_at)` over rows the user had long
   * since finished with. Its only consumer now is the panel's idle header,
   * where it is labeled and sits next to the sessions it describes.
   */
  private lastFleetActivityAt: number | null = null;
  /** Backing the idle panel's "reopen one of these" list. See refreshRecentSessions. */
  private recentSessions: TrayPanelSession[] = [];
  private recentSessionsFetchedAt = 0;
  // ─── iOS Live Activity ────────────────────────────────────────────────
  /**
   * The phone's half of the same snapshot.
   *
   * Owned here rather than beside the strip because the Live Activity is not a
   * render style: it must keep publishing when the menu bar icon is hidden, when
   * the strip is switched off, and on Windows and Linux, where the desktop is
   * still the only thing that knows what the fleet is doing.
   */
  private fleetPublisher: FleetActivityPublisher | null = null;
  private fleetActivityTimer: NodeJS.Timeout | null = null;

  /** Whether the island panel is open; snippets are only read while it is. */
  private islandExpanded = false;
  /** sessionId -> one line of what that session last said. */
  private readonly sessionSnippets = new Map<string, string>();

  private constructor() {}

  static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  /**
   * Set the database worker for querying session metadata.
   * Must be called before initialize().
   */
  setDatabase(database: DatabaseWorker): void {
    this.database = database;
  }

  /**
   * Initialize the tray icon and subscribe to session state events.
   * Throws if SessionStateManager is not available (fail fast).
   */
  async initialize(): Promise<void> {
    // Skip in Playwright tests -- the tray is not useful in test environments
    if (process.env.PLAYWRIGHT) {
      logger.main.info('[TrayManager] Skipping initialization in Playwright mode');
      return;
    }

    const manager = getSessionStateManager();
    if (!manager) {
      throw new Error('[TrayManager] SessionStateManager is not initialized -- cannot create tray without session data source');
    }

    // Always subscribe to session state events so cache stays warm
    this.stateUnsubscribe = manager.subscribe((event: SessionStateEvent) => {
      this.onSessionStateEvent(event);
    });

    // Re-render icon when system appearance changes (needed for non-template icons with blue dots).
    // `nativeTheme.on('updated', ...)` is cross-platform and remains the primary signal on
    // every OS. `systemPreferences.subscribeNotification` is macOS-only (it wraps
    // NSDistributedNotificationCenter and throws on Linux/Windows), so guard it. Without the
    // guard, this method threw at startup on non-darwin and the tray never initialised.
    // See nimbalyst#39.
    const onThemeUpdated = () => this.updateIcon();
    nativeTheme.on('updated', onThemeUpdated);

    let appearanceSubId: number | null = null;
    if (process.platform === 'darwin') {
      appearanceSubId = systemPreferences.subscribeNotification(
        'AppleInterfaceThemeChangedNotification',
        onThemeUpdated,
      );
    }
    this.themeListener = () => {
      nativeTheme.removeListener('updated', onThemeUpdated);
      if (appearanceSubId !== null) {
        systemPreferences.unsubscribeNotification(appearanceSubId);
      }
    };

    // Seed the cache with sessions that are already unread in the database.
    // Without this, sessions that completed before this app session started
    // would never appear in the tray's "Unread" section.
    await this.seedUnreadFromDatabase();

    // Not `createTray()` directly: which surface the menu bar gets is a decision
    // now, and the island has to be able to paint on a launch where there is no
    // tray item at all.
    this.refreshMenuBar();

    this.startFleetActivity();

    logger.main.info('[TrayManager] Initialized');
  }

  /**
   * Show or hide the tray icon. Persists the preference.
   *
   * Only the *icon*. The island is the other menu bar surface and answers to
   * `showTrayStrip` plus the style; conflating the two is how the app ended up
   * drawing both at once.
   */
  setVisible(visible: boolean): void {
    setShowTrayIcon(visible);
    this.refreshMenuBar();
  }

  private createTray(): void {
    if (this.tray) return;
    const icon = this.getIconForState('idle');
    this.tray = new Tray(icon);
    this.tray.setToolTip('Nimbalyst');

    // Where the panel is supported, the sessions live in it and the NSMenu is
    // reduced to app actions on right-click. Elsewhere `rebuildMenu` installs
    // the full session menu via `setContextMenu` and these handlers never run.
    if (isTrayPanelSupported()) {
      this.tray.on('click', () => this.toggleSessionsPanel());
      this.tray.on('right-click', () => {
        if (this.tray && this.appMenu) this.tray.popUpContextMenu(this.appMenu);
      });
    }
  }

  /**
   * Take the tray item away, leaving the island alone.
   *
   * Distinct from `teardownStrip`, which also closes the island: island mode
   * destroys the tray item precisely so the island can keep drawing, so the two
   * must not be the same call.
   */
  private destroyTrayItem(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.appMenu = null;
    this.lastStripKey = null;
    this.stripRenderer?.destroy();
    this.stripRenderer = null;
    closeTrayPanelWindow();
  }

  /**
   * Open the tray panel anchored to the icon, or dismiss it if already open.
   *
   * While the strip is naming a session, clicking it goes to that session --
   * the name is on screen precisely because that session just asked for
   * something, so the click has an obvious target and the panel is a detour.
   */
  private toggleSessionsPanel(): void {
    if (!this.tray) return;
    const named = this.namedSessionId;
    if (named?.workspacePath) {
      this.handleSessionClick(named.sessionId, named.workspacePath);
      return;
    }
    toggleTrayPanelWindow(this.tray.getBounds(), () => this.buildPanelFeed());
  }

  /** The current cross-workspace feed the panel renders. */
  buildPanelFeed(): TrayPanelFeed {
    return groupTraySessions(this.sessionCache.values(), Date.now());
  }

  /**
   * What the panel shows when every bucket is empty.
   *
   * Reads the cached list rather than awaiting a query, because the caller is a
   * synchronous paint. The refresh below is what keeps it current; an empty
   * `recent` on the very first idle paint simply means the read has not landed
   * yet, and the repaint it triggers fills it in.
   */
  private buildIdleSummary(): TrayIdleSummary {
    void this.refreshRecentSessions();
    return {
      ...(this.lastFleetActivityAt !== null ? { lastActivityAt: this.lastFleetActivityAt } : {}),
      recent: this.recentSessions,
    };
  }

  /**
   * The most recently touched sessions, for the idle panel.
   *
   * Deliberately a database read and not the session cache: the cache is a live
   * working set, not a history, and it is empty in exactly the state this list
   * is for. Rate-limited because idle repaints happen on every age tick and this
   * answer changes about as often as the fleet does.
   */
  private async refreshRecentSessions(): Promise<void> {
    if (!this.database) return;
    const now = Date.now();
    if (now - this.recentSessionsFetchedAt < RECENT_SESSIONS_TTL_MS) return;
    this.recentSessionsFetchedAt = now;

    try {
      const { rows } = await this.database.query<any>(
        `SELECT id, title, workspace_id, provider, model, updated_at FROM ai_sessions
         WHERE is_archived = false
         ORDER BY updated_at DESC
         LIMIT ${RECENT_SESSIONS_LIMIT}`
      );
      this.recentSessions = rows.map((row) => ({
        sessionId: row.id,
        title: row.title || 'Untitled Session',
        workspacePath: row.workspace_id || '',
        workspaceName: row.workspace_id ? path.basename(row.workspace_id) : '',
        provider: row.provider || 'claude',
        ...(row.model ? { model: row.model } : {}),
        updatedAt: toMillis(row.updated_at),
        isStreaming: false,
        hasPendingPrompt: false,
        hasError: false,
      }));
      // The paint that asked for this had nothing to show; repaint now that it
      // does. Cheap, and only ever while the fleet is idle.
      void this.tickStrip();
    } catch (error) {
      logger.main.error('[TrayManager] Failed to read recent sessions for the idle panel:', error);
    }
  }

  /**
   * Clean up tray and all subscriptions on app quit.
   */
  shutdown(): void {
    if (this.stateUnsubscribe) {
      this.stateUnsubscribe();
      this.stateUnsubscribe = null;
    }

    if (this.themeListener) {
      this.themeListener();
      this.themeListener = null;
    }

    if (this.menuRebuildTimer) {
      clearTimeout(this.menuRebuildTimer);
      this.menuRebuildTimer = null;
    }

    for (const timer of this.lingerTimers.values()) {
      clearTimeout(timer);
    }
    this.lingerTimers.clear();

    this.teardownStrip();
    this.stopFleetActivity();

    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    closeTrayPanelWindow();
    this.appMenu = null;
    this.sessionCache.clear();
    logger.main.info('[TrayManager] Shutdown');
  }

  // ─── Prompt state tracking (called from AIService) ──────────────────────

  /**
   * Mark a session as having a pending interactive prompt (blocked on user input).
   * Called from AIService when askUserQuestion, toolPermission, exitPlanMode,
   * or gitCommitProposal events fire.
   *
   * `kind` separates "a tap" from "thinking required", which is what colours the
   * strip's dot -- a session title does not tell you whether responding costs
   * three seconds or ten minutes. It defaults to `approval` because that is what
   * an unlabelled prompt overwhelmingly is (tool permissions).
   */
  onPromptCreated(sessionId: string, kind: PromptKind = 'approval'): void {
    this.lastFleetActivityAt = Date.now();
    const session = this.sessionCache.get(sessionId);
    if (session) {
      // Only a transition *into* waiting stamps the clock. A session that is
      // already blocked keeps its original timestamp, so the strip's age means
      // "how long has this been waiting" and the name is not re-shown.
      if (!session.hasPendingPrompt) session.wantingSince = Date.now();
      session.hasPendingPrompt = true;
      session.promptKind = kind;
      this.scheduleMenuRebuild();
    }
  }

  /**
   * Clear the pending prompt flag when the user responds.
   */
  onPromptResolved(sessionId: string): void {
    this.lastFleetActivityAt = Date.now();
    const session = this.sessionCache.get(sessionId);
    if (session) {
      session.hasPendingPrompt = false;
      session.promptKind = undefined;
      if (session.status !== 'error') session.wantingSince = undefined;
      this.scheduleMenuRebuild();
    }
  }

  /**
   * Mark a session as having unread messages.
   * Called from ai:updateSessionMetadata when the renderer persists hasUnread changes.
   * If the session isn't in the cache yet (e.g., it completed before the tray initialized),
   * fetch its metadata from the database and add it.
   */
  onSessionUnread(sessionId: string, hasUnread: boolean): void {
    const session = this.sessionCache.get(sessionId);
    if (session) {
      session.hasUnread = hasUnread;
      // If no longer unread and not running/attention, remove from cache
      if (!hasUnread && session.status !== 'running' && !session.hasPendingPrompt) {
        this.sessionCache.delete(sessionId);
      }
      this.scheduleMenuRebuild();
      return;
    }

    // Session not in cache -- if marking as unread, fetch metadata and add it
    if (hasUnread) {
      this.fetchSessionMetadata(sessionId).then((info) => {
        info.status = 'completed';
        info.hasUnread = true;
        this.sessionCache.set(sessionId, info);
        this.scheduleMenuRebuild();
      });
    }
  }

  /**
   * Take a phase change into the cache as it is written.
   *
   * `phase` decides whether a running session is counted at all, and the cache
   * used to read it exactly once -- at `fetchSessionMetadata`, when the session
   * first appeared. Nothing wrote it back, so the guard below could only ever
   * act on a value that was already stale by a turn.
   *
   * Called from `SessionNamingService.applySessionMetadata`, the funnel every
   * agent-driven and commit-driven metadata write already goes through, and
   * from the renderer's `ai:updateSessionMetadata` handler alongside the
   * existing `hasUnread` forward. A session not in the cache is not a miss:
   * it is not on any ambient surface, and it will read the current phase when
   * it next starts a turn.
   */
  onSessionPhaseChanged(sessionId: string, phase: string): void {
    const session = this.sessionCache.get(sessionId);
    if (!session || session.phase === phase) return;
    session.phase = phase;
    this.scheduleMenuRebuild();
  }

  // ─── Session state event handling ───────────────────────────────────────

  /**
   * Re-read the fields the cache froze when the session first entered it.
   *
   * `title` already had `refreshCachedTitles`, but that one runs over the rows
   * the panel is *about* to show -- which cannot recover a session that a stale
   * `phase` has excluded from the feed in the first place. This reads by id, so
   * it works on exactly the sessions the feed cannot see.
   *
   * `isArchived` comes along because it is the other frozen field that decides
   * visibility, off the same row.
   */
  private async refreshCachedSessionFlags(session: TraySessionInfo): Promise<void> {
    if (!this.database) return;

    try {
      const { rows } = await this.database.query<{ is_archived: unknown; metadata: unknown }>(
        `SELECT is_archived, metadata FROM ai_sessions WHERE id = $1`,
        [session.sessionId],
      );
      if (rows.length === 0) return;

      const metadata = parseMetadataColumn(rows[0].metadata);
      session.phase = typeof metadata.phase === 'string' ? metadata.phase : undefined;
      session.isArchived = !!rows[0].is_archived;
    } catch (error) {
      // Failing to refresh leaves the previous value, which is what the cache
      // did unconditionally before. It must never cost the panel.
      logger.main.warn(
        `[TrayManager] Failed to refresh cached flags for ${session.sessionId}:`,
        error,
      );
    }
  }

  private async onSessionStateEvent(event: SessionStateEvent): Promise<void> {
    switch (event.type) {
      case 'session:started':
      case 'session:streaming': {
        // Ensure session is in cache, fetch metadata if needed
        let session = this.sessionCache.get(event.sessionId);
        if (!session) {
          session = await this.fetchSessionMetadata(event.sessionId);
          this.sessionCache.set(event.sessionId, session);
        }
        // A restart clears a previous failure, so it must also clear the clock
        // that failure started -- otherwise the strip ages a session that is
        // running again. A pending prompt keeps its own stamp.
        if (session.status === 'error' && !session.hasPendingPrompt) {
          session.wantingSince = undefined;
        }
        // Stamp only the transition *into* running. `session:streaming` fires
        // repeatedly for the same run, and re-stamping would make the strip
        // announce a working session over and over instead of once as it starts.
        const enteringRun = session.status !== 'running' || session.startedAt === undefined;
        if (enteringRun) {
          session.startedAt = Date.now();
          // A new run is not the old run's completion; leaving this set would
          // keep the finished session eligible to be named a second time.
          session.completedAt = undefined;
        }
        session.status = 'running';
        session.isStreaming = event.type === 'session:streaming';
        // Clear any linger timer if session restarts
        this.clearLingerTimer(event.sessionId);
        // The one moment a stale `phase` is guaranteed to cost something: the
        // session is about to be judged by it. Bounded to the transition rather
        // than every `session:streaming` tick, which fires throughout a turn and
        // would make this a query per tick.
        //
        // Deliberately after the mutations above rather than before them: the
        // await is a window in which a short turn's `session:completed` can land,
        // and resuming into `status = 'running'` on the far side of it would
        // strand a finished session in the running bucket. The refresh writes
        // only `phase` and `isArchived`, which no other branch touches.
        if (enteringRun) await this.refreshCachedSessionFlags(session);
        break;
      }

      case 'session:completed': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          session.status = 'completed';
          session.isStreaming = false;
          session.hasPendingPrompt = false; // Session done -- can't be blocked
          session.promptKind = undefined;
          session.wantingSince = undefined;
          session.completedAt = Date.now();

          // Check if app is backgrounded -- if so, mark as unread. The tray
          // panel does not count: the user opening it to check on sessions must
          // not suppress the unread flag on everything that finishes meanwhile.
          const hasVisibleFocusedWindow = projectWindows().some(w => w.isVisible() && w.isFocused());
          if (!hasVisibleFocusedWindow) {
            session.hasUnread = true;
          }

          // Start linger timer -- remove from cache after COMPLETED_LINGER_MS
          this.startLingerTimer(event.sessionId);
        }
        break;
      }

      case 'session:error': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          // Failing is a transition into wanting something, and gets named like
          // one -- a failure you never see is worse than one that interrupts.
          if (session.status !== 'error') session.wantingSince = Date.now();
          session.status = 'error';
          session.isStreaming = false;
        }
        break;
      }

      case 'session:interrupted': {
        // Remove immediately -- interrupted sessions don't need tray visibility
        this.sessionCache.delete(event.sessionId);
        this.clearLingerTimer(event.sessionId);
        break;
      }

      case 'session:waiting': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          if (session.status === 'error' && !session.hasPendingPrompt) {
            session.wantingSince = undefined;
          }
          session.status = 'running';
          session.isStreaming = false;
        }
        break;
      }

      case 'session:activity': {
        // The liveness tick (see turnLivenessTicker). This is the *only* signal
        // that a long turn is still working: `updatedAt` below moves on
        // transitions, and a turn inside a thirty-minute tool call makes none,
        // so measuring silence against it called every long turn stalled.
        //
        // It deliberately does not fall through to the rebuild at the bottom.
        // A tick a minute that says "still running" changes nothing on screen,
        // and repainting the island for it would be a minute-by-minute redraw
        // in the user's peripheral vision. The one visible consequence -- a
        // session climbing back out of the stalled bucket -- is handled below.
        const alive = this.sessionCache.get(event.sessionId);
        if (!alive) return;

        const wasStalled = alive.status === 'running'
          && alive.phase !== 'complete'
          && !alive.hasPendingPrompt
          && isStalled(alive, Date.now());

        alive.liveAt = Date.now();
        alive.turnInFlight = true;

        // Only a bucket change is worth a repaint.
        if (wasStalled) this.scheduleMenuRebuild();
        return;
      }
    }

    // `turnInFlight` tracks the ticker's lifetime, so it flips on exactly the
    // events that start and end a turn. Not on `session:waiting`: a session
    // blocked on a prompt still has its turn open (and its ticker running), and
    // it is bucketed by `hasPendingPrompt` long before liveness matters.
    const settled = this.sessionCache.get(event.sessionId);
    if (settled) {
      if (event.type === 'session:started' || event.type === 'session:streaming') {
        settled.turnInFlight = true;
        settled.liveAt = Date.now();
      } else if (event.type === 'session:completed' || event.type === 'session:error') {
        settled.turnInFlight = false;
      }
    }

    // Every branch above is a state change, so the panel's relative-time label
    // should track it -- the cached `updated_at` from the DB goes stale as soon
    // as the session starts moving.
    const touched = this.sessionCache.get(event.sessionId);
    if (touched) touched.updatedAt = Date.now();
    this.lastFleetActivityAt = Date.now();

    this.scheduleMenuRebuild();
  }

  // ─── Menu item dot icons ────────────────────────────────────────────────

  /** Cached dot icons (created once, reused across menu rebuilds) */
  private dotIconCache: Map<string, Electron.NativeImage> = new Map();

  /**
   * Create a small colored dot NativeImage for use as a menu item icon.
   * macOS renders these at 16x16 in menus; we draw at @2x (32x32) for retina.
   */
  private getDotIcon(hex: string): Electron.NativeImage {
    const cached = this.dotIconCache.get(hex);
    if (cached) return cached;

    const size = 32;
    const canvas = Buffer.alloc(size * size * 4, 0);

    // Parse hex color
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    // Draw a filled circle centered at (16, 16) with radius 5.
    // macOS nativeImage bitmap format is BGRA, not RGBA.
    const cx = 16, cy = 16, radius = 5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= radius * radius) {
          const offset = (y * size + x) * 4;
          canvas[offset] = b;
          canvas[offset + 1] = g;
          canvas[offset + 2] = r;
          canvas[offset + 3] = 255;
        }
      }
    }

    const image = nativeImage.createFromBuffer(canvas, {
      width: size,
      height: size,
      scaleFactor: 2.0,
    });
    this.dotIconCache.set(hex, image);
    return image;
  }

  // ─── Menu building ──────────────────────────────────────────────────────

  private scheduleMenuRebuild(): void {
    if (this.menuRebuildTimer) {
      clearTimeout(this.menuRebuildTimer);
    }
    this.menuRebuildTimer = setTimeout(() => {
      this.menuRebuildTimer = null;
      // Ahead of `rebuildMenu`, which returns early when the tray icon is
      // hidden. The phone's card has nothing to do with whether there is an icon
      // in this machine's menu bar.
      this.publishFleetActivity();
      this.refreshMenuBar();
    }, MENU_REBUILD_DEBOUNCE_MS);
  }

  /** Last built app-actions menu, popped up on right-click when the panel owns left-click. */
  private appMenu: Electron.Menu | null = null;

  /**
   * Reconcile the menu bar: exactly one fleet-status surface, never two.
   *
   * The island and the tray item are alternatives, not layers. Before this was a
   * decision the island drew in the middle of the menu bar *and* the tray item
   * sat on the right with its own state dot, which is two presences for one
   * fleet and made the style setting look broken. Island mode therefore takes
   * the tray item away entirely -- and that is what the island's own gear panel
   * exists to compensate for, because the tray's right-click menu goes with it.
   */
  private refreshMenuBar(): void {
    if (this.isIslandActive()) {
      this.destroyTrayItem();
      void this.updateStrip();
      this.updateDockBadge(this.buildPanelFeed().needsAttention.length);
      return;
    }

    closeMenuBarIsland();
    if (isShowTrayIcon()) this.createTray();
    else this.destroyTrayItem();
    if (!this.tray) return;

    const feed = this.buildPanelFeed();
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    // Sessions only appear in the NSMenu on platforms without the panel.
    if (!isTrayPanelSupported()) {
      menuItems.push(...this.buildSessionMenuItems(feed));
    }

    menuItems.push(...this.buildAppMenuItems());

    const menu = Menu.buildFromTemplate(menuItems);
    this.appMenu = menu;
    if (isTrayPanelSupported()) {
      // Left-click opens the panel, so no context menu is installed -- the menu
      // is popped up explicitly from the 'right-click' handler instead.
      pushTrayPanelFeed(feed);
    } else {
      this.tray.setContextMenu(menu);
    }

    // Update icon state
    this.updateIcon();

    // Update dock badge
    this.updateDockBadge(feed.needsAttention.length);
  }

  /**
   * Legacy flat session sections. Retained for Windows/Linux, where the tray
   * panel (which needs `type: 'panel'` and vibrancy) is not available.
   */
  private buildSessionMenuItems(feed: TrayPanelFeed): Electron.MenuItemConstructorOptions[] {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    const blueDot = this.getDotIcon('#3B82F6');
    const orangeDot = this.getDotIcon('#F97316');
    const redDot = this.getDotIcon('#EF4444');

    // Needs Attention section
    if (feed.needsAttention.length > 0) {
      menuItems.push({ label: 'Needs Attention', enabled: false });
      for (const session of feed.needsAttention) {
        const suffix = session.hasError ? ' (error)' : ' (blocked)';
        menuItems.push({
          label: this.truncateTitle(session.title) + suffix,
          icon: session.hasError ? redDot : orangeDot,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // Running section
    if (feed.running.length > 0) {
      menuItems.push({ label: 'Running', enabled: false });
      for (const session of feed.running) {
        const suffix = session.isStreaming ? ' (streaming...)' : '';
        menuItems.push({
          label: this.truncateTitle(session.title) + suffix,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // Unread section
    if (feed.unread.length > 0) {
      menuItems.push({ label: 'Unread', enabled: false });
      for (const session of feed.unread) {
        menuItems.push({
          label: this.truncateTitle(session.title),
          icon: blueDot,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({
        label: 'Clear All Unread',
        click: () => {
          void this.clearAllUnreadSessions();
        },
      });
      menuItems.push({ type: 'separator' });
    }

    return menuItems;
  }

  /** App-level actions. The whole right-click menu once the panel owns sessions. */
  private buildAppMenuItems(): Electron.MenuItemConstructorOptions[] {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    menuItems.push({
      label: 'New Session',
      click: () => this.handleNewSession(),
    });
    menuItems.push({
      label: 'Open Nimbalyst',
      click: () => this.handleOpenApp(),
    });
    // Prevent Sleep submenu (only show when sync is configured)
    const syncConfig = getSessionSyncConfig();
    if (syncConfig?.enabled) {
      const currentMode = resolvePreventSleepMode(syncConfig);
      const setMode = (mode: 'off' | 'always' | 'pluggedIn') => this.setPreventSleepMode(mode);
      menuItems.push({
        label: 'Prevent Sleep',
        submenu: [
          { label: 'Off', type: 'radio', checked: currentMode === 'off', click: () => setMode('off') },
          { label: 'Always', type: 'radio', checked: currentMode === 'always', click: () => setMode('always') },
          { label: 'When Plugged In', type: 'radio', checked: currentMode === 'pluggedIn', click: () => setMode('pluggedIn') },
        ],
      });
    }
    // `Hide Menu Bar Icon` takes everything away; a user may want the icon
    // without a wide strip, which on a laptop is the difference between the
    // item fitting and vanishing under the notch.
    if (process.platform === 'darwin') {
      menuItems.push({
        label: 'Show Fleet Status',
        type: 'checkbox',
        checked: isShowTrayStrip(),
        click: () => this.setStripVisible(!isShowTrayStrip()),
      });
      if (isShowTrayStrip()) {
        const style = getTrayStripStyle();
        menuItems.push({
          label: 'Fleet Status Style',
          submenu: [
            {
              label: 'Menu Bar Item',
              type: 'radio',
              checked: style === 'image',
              click: () => this.setStripStyle('image'),
            },
            {
              label: 'Island',
              type: 'radio',
              checked: style === 'island',
              click: () => this.setStripStyle('island'),
            },
          ],
        });
      }
    }
    menuItems.push({
      label: 'Hide Menu Bar Icon',
      click: () => this.setVisible(false),
    });
    menuItems.push({ type: 'separator' });
    menuItems.push({
      label: 'Quit',
      click: () => app.quit(),
    });

    return menuItems;
  }

  // ─── Icon management ───────────────────────────────────────────────────

  /** Cached base template image (loaded once from disk) */
  private templateIcon: Electron.NativeImage | null = null;

  private updateIcon(): void {
    if (!this.tray) return;

    if (this.isStripEnabled()) {
      // The strip replaces both the icon and the title: it is one image that
      // already carries the glyph, the state colours and the counts.
      void this.updateStrip();
      return;
    }

    this.teardownStrip();

    const state = this.computeIconState();
    const icon = this.getIconForState(state);
    this.tray.setImage(icon);

    // Update title text on macOS (shown next to the icon). `setTitle` is a
    // macOS-only Tray method; calling it on Linux/Windows is documented as a
    // no-op but the API is officially `darwin` only. Guard it to keep the
    // intent explicit and avoid future Electron versions throwing here.
    if (process.platform === 'darwin') {
      const runningCount = this.getRunningCount();
      const attentionCount = this.getAttentionCount();
      if (attentionCount > 0) {
        this.tray.setTitle(` ${attentionCount}`);
      } else if (runningCount > 0) {
        this.tray.setTitle(` ${runningCount}`);
      } else {
        this.tray.setTitle('');
      }
    }
  }

  // ─── Menu bar strip ────────────────────────────────────────────────────

  /**
   * The strip is a rendered bitmap on the macOS status bar. Windows and Linux
   * keep the template icon plus the flat `NSMenu` session list -- they have no
   * equivalent surface, and `setTitle` is darwin-only anyway.
   */
  private isStripEnabled(): boolean {
    return process.platform === 'darwin' && isShowTrayStrip();
  }

  /**
   * Whether the island owns the menu bar, and therefore whether the tray item
   * must not exist. The one predicate `refreshMenuBar` and `paintStrip` share,
   * so the two can never disagree about which surface is live.
   */
  private isIslandActive(): boolean {
    return this.isStripEnabled()
      && getTrayStripStyle() === 'island'
      && isMenuBarIslandSupported();
  }

  /** The current cross-workspace fleet snapshot, with a fresh revision. */
  buildFleetSnapshot(now: number = Date.now()): FleetSnapshot {
    this.snapshotRevision += 1;
    return deriveFleetSnapshot(this.sessionCache.values(), this.snapshotRevision, {
      now,
      ...(this.lastFleetActivityAt !== null ? { lastActivityAt: this.lastFleetActivityAt } : {}),
    });
  }

  // ─── iOS Live Activity ─────────────────────────────────────────────────

  /**
   * Start publishing the fleet to the phone.
   *
   * Its own timer rather than a ride on `stripAgeTimer`, for the same reason it
   * is not part of `paintStrip`: the strip's timer only exists while the strip
   * is enabled and the tray icon is showing, and neither has any bearing on
   * whether a phone across the room should know a session went quiet. The
   * interval is the same, because the thing it catches is the same -- a stall
   * emits no event, so it is only ever noticed by re-deriving on a clock.
   */
  private startFleetActivity(): void {
    if (this.fleetPublisher) return;
    // `isStripEnabled()` is read at flush time rather than captured here: the
    // user can toggle Show Fleet Status from the tray menu at any point, and the
    // phone should hear the current answer on the next send rather than whatever
    // was true when the publisher was constructed.
    this.fleetPublisher = new FleetActivityPublisher({
      send: (payload) =>
        sendFleetActivity(payload, this.isStripEnabled() && isShowTrayIcon()),
    });
    this.publishFleetActivity();
    this.fleetActivityTimer = setInterval(() => this.publishFleetActivity(), STRIP_AGE_TICK_MS);
    this.fleetActivityTimer.unref?.();
  }

  private stopFleetActivity(): void {
    if (this.fleetActivityTimer) {
      clearInterval(this.fleetActivityTimer);
      this.fleetActivityTimer = null;
    }
    this.fleetPublisher?.stop();
    this.fleetPublisher = null;
  }

  /**
   * Hand the publisher the current truth. It decides whether that is news.
   *
   * Cheap enough to call on every rebuild by design -- the coalescing lives in
   * the publisher, so no caller has to reason about the APNs budget.
   */
  private publishFleetActivity(): void {
    if (!this.fleetPublisher || !isFleetActivityAvailable()) return;
    const now = Date.now();
    const snapshot = this.buildFleetSnapshot(now);
    this.fleetPublisher.submit(
      buildFleetActivityPayload(snapshot, this.sessionCache.values(), now),
    );
  }

  private async updateStrip(): Promise<void> {
    const now = Date.now();
    const view = this.stripMachine.update(this.buildFleetSnapshot(now), now);
    this.scheduleStripTimers();
    await this.paintStrip(view);
  }

  /**
   * Redraw against the last snapshot at the current time.
   *
   * Used for the one thing that changes without either a session event or a
   * reclassification: a name hold expiring.
   */
  private async tickStrip(): Promise<void> {
    if (!this.tray || !this.isStripEnabled()) return;
    const view = this.stripMachine.tick(Date.now());
    this.scheduleStripTimers();
    await this.paintStrip(view);
  }

  /**
   * Re-derive on the clock, not just on events.
   *
   * A session going quiet emits nothing -- that is what makes it a stall -- so
   * the stalled bucket only exists if something re-runs the derivation
   * periodically. `tickStrip` cannot do it: it re-renders the *last* snapshot,
   * so a session could sit silent for an hour and never be reclassified. The
   * blocked-age rolling over a minute needs the same interval anyway.
   */
  private async reviseStrip(): Promise<void> {
    if (!this.tray || !this.isStripEnabled()) return;
    await this.updateStrip();
  }

  private async paintStrip(view: StripView): Promise<void> {
    this.namedSessionId = view.mode === 'named'
      ? { sessionId: view.sessionId, workspacePath: view.workspacePath }
      : null;

    if (this.isIslandActive()) {
      this.paintIsland(view);
      return;
    }
    closeMenuBarIsland();

    const key = stripViewKey(view);
    if (key === this.lastStripKey) return;

    if (!this.stripRenderer) this.stripRenderer = new TrayStripRenderer();
    const image = await this.stripRenderer.render(view);
    // The tray can be gone by the time the render lands.
    if (!image || !this.tray || this.tray.isDestroyed?.()) return;

    this.lastStripKey = key;
    this.tray.setImage(image);
    // The strip carries its own counts, so the title would be a second copy.
    if (process.platform === 'darwin') this.tray.setTitle('');
  }

  /**
   * The island render style.
   *
   * The island is a live window, so unlike the bitmap strip there is no image to
   * cache and no `stripViewKey` short-circuit -- the renderer diffs for us, and
   * the session rows have to keep arriving even when the strip line is unchanged.
   *
   * It paints in every state, including the quiet one, where the strip line
   * collapses to the bare app glyph. That is not decoration: island mode removes
   * the tray item, so a pill that vanished when the fleet went quiet would leave
   * an idle Mac with no way to open the panel, reach the gear, or switch the
   * style back.
   */
  private paintIsland(view: StripView): void {
    const feed = this.buildPanelFeed();
    // Refreshed here rather than on a timer: a repaint is exactly when the rows
    // changed, and the guard inside makes it a no-op while the panel is closed.
    void this.refreshSessionSnippets(feed);
    const idle = isIdleView(view) ? this.buildIdleSummary() : undefined;
    showMenuBarIsland({
      strip: toIslandStrip(view),
      feed,
      snippets: Object.fromEntries(this.sessionSnippets),
      settings: this.buildIslandSettings(),
      ...(idle ? { idle } : {}),
    });

    this.lastStripKey = ISLAND_STRIP_KEY;
  }

  /**
   * What the island's gear panel shows.
   *
   * Read fresh on every frame rather than pushed on change: the same settings
   * are also reachable from the tray menu and from app Settings, and a panel
   * that cached its own copy would show a stale toggle after either.
   */
  private buildIslandSettings(): MenuBarIslandSettings {
    const syncConfig = getSessionSyncConfig();
    return {
      style: getTrayStripStyle(),
      showFleetStatus: isShowTrayStrip(),
      osNotifications: isOSNotificationsEnabled(),
      // Null, not 'off'. Sleep prevention only means anything while sync is
      // configured, which is why the tray menu omits it in that case too.
      preventSleep: syncConfig?.enabled ? resolvePreventSleepMode(syncConfig) : null,
    };
  }

  /** Apply one change from the island's gear panel. */
  applyIslandSetting(change: MenuBarIslandSettingChange): void {
    switch (change.key) {
      case 'style':
        this.setStripStyle(change.value);
        return;
      case 'showFleetStatus':
        this.setStripVisible(change.value);
        return;
      case 'osNotifications':
        setOSNotificationsEnabled(change.value);
        // App Settings holds its own copy of this and rewrites the whole
        // notification block on any edit, so a window that never heard about
        // this change would silently put the old value back.
        this.broadcastNotificationsEnabled(change.value);
        this.refreshMenuBar();
        return;
      case 'preventSleep':
        this.setPreventSleepMode(change.value);
        return;
    }
  }

  private broadcastNotificationsEnabled(enabled: boolean): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('notifications:enabled-changed', enabled);
    }
  }

  /**
   * Set the sleep-prevention mode and tell everyone who caches it.
   *
   * Shared by the tray menu item and the island's gear panel so the two cannot
   * apply it differently -- this was a closure inside `buildAppMenuItems`, which
   * put it out of reach of the second caller.
   */
  private setPreventSleepMode(mode: 'off' | 'always' | 'pluggedIn'): void {
    const currentConfig = getSessionSyncConfig();
    if (!currentConfig) return;
    const updated = { ...currentConfig, preventSleepMode: mode, preventSleepWhenSyncing: undefined };
    setSessionSyncConfig(updated);
    updateSleepPrevention();
    this.scheduleMenuRebuild();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('sync:config-updated', updated);
    }
  }

  private scheduleStripTimers(): void {
    if (this.stripHoldTimer) {
      clearTimeout(this.stripHoldTimer);
      this.stripHoldTimer = null;
    }
    const holdEndsAt = this.stripMachine.holdEndsAt();
    if (holdEndsAt !== null) {
      this.stripHoldTimer = setTimeout(
        () => {
          this.stripHoldTimer = null;
          void this.tickStrip();
        },
        Math.max(0, holdEndsAt - Date.now()) + 1,
      );
    }

    if (!this.stripAgeTimer) {
      this.stripAgeTimer = setInterval(() => void this.reviseStrip(), STRIP_AGE_TICK_MS);
      // Nothing in the menu bar is worth keeping the event loop alive for.
      this.stripAgeTimer.unref?.();
    }
  }

  private teardownStrip(): void {
    if (this.stripHoldTimer) {
      clearTimeout(this.stripHoldTimer);
      this.stripHoldTimer = null;
    }
    if (this.stripAgeTimer) {
      clearInterval(this.stripAgeTimer);
      this.stripAgeTimer = null;
    }
    this.stripRenderer?.destroy();
    this.stripRenderer = null;
    closeMenuBarIsland();
    this.lastStripKey = null;
    this.namedSessionId = null;
  }

  /**
   * Told by the island when it opens or closes.
   *
   * Opening is the trigger to go and read the snippets, because that is the
   * only moment they are about to be seen. Closing drops them so a stale line
   * cannot flash on the next open before the fresh read lands.
   */
  onIslandExpandedChange(expanded: boolean): void {
    this.islandExpanded = expanded;
    if (!expanded) {
      this.sessionSnippets.clear();
      return;
    }
    void this.refreshSessionSnippets(this.buildPanelFeed()).then(() => {
      if (this.islandExpanded) void this.tickStrip();
    });
  }

  /**
   * Read what the panel's rows say, for every session it is about to show.
   *
   * Two batched queries, never one per row: the snippet read is against the
   * largest table in the database. Skipped entirely while the panel is closed,
   * which is almost always -- a read per `session:streaming` tick would be
   * indefensible.
   *
   * The stalled bucket is included. It was left out when this was written, which
   * meant the one bucket whose rows say the least ("running, but silent") was
   * also the only one with no line of context under the title.
   */
  private async refreshSessionSnippets(feed: TrayPanelFeed): Promise<void> {
    if (!this.islandExpanded || !this.database) return;

    const ids = [...feed.needsAttention, ...feed.running, ...feed.stalled, ...feed.unread]
      .map((session) => session.sessionId);

    await Promise.all([this.refreshSnippetLines(ids), this.refreshCachedTitles(ids)]);
  }

  private async refreshSnippetLines(ids: string[]): Promise<void> {
    const sql = latestAssistantTextSql(ids);
    if (!sql) return;

    try {
      const { rows } = await this.database!.query<{ session_id: string; searchable_text: string }>(sql);
      this.sessionSnippets.clear();
      for (const row of rows) {
        const line = toSnippetLine(row.searchable_text);
        if (line) this.sessionSnippets.set(row.session_id, line);
      }
    } catch (error) {
      // A missing snippet costs a line of context; it must never cost the panel.
      logger.main.warn('[TrayManager] Failed to read session snippets:', error);
    }
  }

  /**
   * Re-read the titles of the rows about to be shown.
   *
   * The cache fills `title` once, when the session first enters it, and a
   * session is renamed routinely afterwards -- so the panel was naming sessions
   * by whatever they were called at first sight. Writing back into the cache
   * rather than into the feed means the strip, the native menu and the Live
   * Activity all get the correction too.
   */
  private async refreshCachedTitles(ids: string[]): Promise<void> {
    const sql = sessionTitlesSql(ids);
    if (!sql) return;

    try {
      const { rows } = await this.database!.query<{ id: string; title: string | null }>(sql);
      for (const row of rows) {
        const session = this.sessionCache.get(row.id);
        if (session && row.title && row.title !== session.title) {
          session.title = row.title;
        }
      }
    } catch (error) {
      // A stale title is a cosmetic loss; it must never cost the panel.
      logger.main.warn('[TrayManager] Failed to refresh session titles:', error);
    }
  }

  /**
   * Switch between the bitmap strip and the island.
   *
   * The two surfaces are exclusive, so this is a swap rather than a toggle:
   * `refreshMenuBar` tears down whichever one is leaving before the incoming one
   * paints. Without the teardown the tray would keep the last bitmap forever.
   */
  setStripStyle(style: TrayStripStyle): void {
    if (style === getTrayStripStyle()) return;
    setTrayStripStyle(style);
    closeMenuBarIsland();
    this.lastStripKey = null;
    this.refreshMenuBar();
  }

  /**
   * Show or hide the fleet status, independently of the tray icon itself.
   *
   * Turning it off in island mode is what brings the tray icon back -- it is the
   * only menu bar presence left, and the way back to this setting.
   */
  setStripVisible(visible: boolean): void {
    setShowTrayStrip(visible);
    this.lastStripKey = null;
    this.refreshMenuBar();
  }

  private computeIconState(): TrayIconState {
    let hasError = false;
    let hasAttention = false;
    let hasRunning = false;

    for (const session of this.sessionCache.values()) {
      if (session.status === 'error') hasError = true;
      if (session.hasPendingPrompt || session.hasUnread) hasAttention = true;
      if (session.status === 'running') hasRunning = true;
    }

    // Priority order: Error > Needs Attention > Running > Idle
    if (hasError) return 'error';
    if (hasAttention) return 'attention';
    if (hasRunning) return 'running';
    return 'idle';
  }

  /**
   * Load the pre-rendered template icon from resources.
   * Falls back to a 1x1 transparent image if the file is missing (should never happen).
   */
  private loadTemplateIcon(): Electron.NativeImage {
    if (this.templateIcon) return this.templateIcon;

    // In dev: resources/ is at the package root (packages/electron/resources/)
    // getPackageRoot() handles alternate outDir (e.g. out2/main) correctly.
    // In packaged builds: electron-builder copies resources/ into the app Resources dir.
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.join(getPackageRoot(), 'resources');

    const iconPath = path.join(resourcesDir, 'trayTemplate.png');
    const icon2xPath = path.join(resourcesDir, 'trayTemplate@2x.png');

    // nativeImage.createFromPath handles @2x variants automatically when
    // the base path is given, but only if both files exist at the same location.
    // Load explicitly to ensure correct scale factor mapping.
    try {
      this.templateIcon = nativeImage.createFromPath(iconPath);
      if (this.templateIcon.isEmpty()) {
        logger.main.warn(`[TrayManager] Template icon is empty at ${iconPath}, trying @2x`);
        this.templateIcon = nativeImage.createFromPath(icon2xPath);
      }
    } catch {
      logger.main.warn(`[TrayManager] Failed to load template icon from ${iconPath}`);
      this.templateIcon = nativeImage.createEmpty();
    }

    return this.templateIcon;
  }

  private getIconForState(state: TrayIconState): Electron.NativeImage {
    const baseIcon = this.loadTemplateIcon();
    const needsColorDot = state === 'attention' || state === 'error';

    // For states without a colored dot, use the template image directly.
    // macOS automatically tints template images white on dark menu bars and
    // dark on light menu bars. This tinting is handled by the OS at the
    // NSStatusBar level and is NOT affected by nativeTheme.themeSource.
    if (!needsColorDot) {
      // Ensure the template flag is set (Electron auto-detects from filename
      // "trayTemplate.png" but be explicit)
      baseIcon.setTemplateImage(true);
      return baseIcon;
    }

    // For attention/error states, we need a colored blue dot overlay.
    // Template images are monochrome so we must render manually.
    //
    // Work at @2x (32x32 pixels) for retina crispness.
    const scaleFactor = 2.0;
    const physicalSize = 32; // 16pt * 2

    // Get the raw bitmap at @2x scale (macOS uses BGRA byte order)
    const baseBitmap = baseIcon.toBitmap({ scaleFactor });
    const canvas = Buffer.from(baseBitmap);

    // Always use white (255) foreground for the attention/error icon.
    //
    // Why not detect dark vs light menu bar?
    // - systemPreferences.getEffectiveAppearance() returns the system appearance
    //   ('light'/'dark'), but the macOS menu bar is TRANSLUCENT -- a dark wallpaper
    //   makes it appear dark even in light mode. There's no Electron API to detect
    //   the actual menu bar background luminance.
    // - Template images handle this automatically (macOS tints them at the
    //   NSStatusBar level), but we can't use template mode here because we have
    //   colored pixels (the blue dot).
    // - White foreground matches what other apps (ChatGPT, Slack) use for their
    //   status bar icons when they include colored elements.
    const fg = 255;

    for (let i = 0; i < canvas.length; i += 4) {
      if (canvas[i + 3] > 0) {
        canvas[i] = fg;
        canvas[i + 1] = fg;
        canvas[i + 2] = fg;
      }
    }

    // Draw blue dot in bottom-right (BGRA byte order)
    const dotCx = Math.floor(physicalSize * 0.78);
    const dotCy = Math.floor(physicalSize * 0.78);
    const dotR = Math.floor(physicalSize * 0.14);
    for (let y = dotCy - dotR; y <= dotCy + dotR; y++) {
      for (let x = dotCx - dotR; x <= dotCx + dotR; x++) {
        if (x < 0 || x >= physicalSize || y < 0 || y >= physicalSize) continue;
        const dx = x - dotCx, dy = y - dotCy;
        if (dx * dx + dy * dy <= dotR * dotR) {
          const offset = (y * physicalSize + x) * 4;
          canvas[offset] = 246;     // B: #F6
          canvas[offset + 1] = 130;  // G: #82
          canvas[offset + 2] = 59;   // R: #3B
          canvas[offset + 3] = 255;
        }
      }
    }

    const image = nativeImage.createFromBuffer(canvas, {
      width: physicalSize,
      height: physicalSize,
      scaleFactor,
    });
    // Must NOT be template -- we have colored pixels (blue dot)
    image.setTemplateImage(false);
    return image;
  }

  // ─── Dock badge ────────────────────────────────────────────────────────

  private updateDockBadge(attentionCount: number): void {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(attentionCount > 0 ? String(attentionCount) : '');
    }
  }

  // ─── Session click handling ────────────────────────────────────────────

  handleNewSession(): void {
    const windows = projectWindows();
    if (windows.length > 0) {
      const win = windows[0];
      win.show();
      win.focus();
      // Tell renderer to switch to agent mode and create a new session
      win.webContents.send('tray:new-session');
    }
  }

  /** Focus any project window. Shared by the native menu item and the panel footer. */
  handleOpenApp(): void {
    const windows = projectWindows();
    if (windows.length > 0) {
      windows[0].show();
      windows[0].focus();
    }
  }

  handleSessionClick(sessionId: string, workspacePath: string): void {
    if (!workspacePath) {
      throw new Error(`[TrayManager] workspacePath is missing for session ${sessionId} -- cache bug`);
    }

    const targetWindow = findWindowByWorkspace(workspacePath);
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.show();
      targetWindow.focus();
      // Send navigation request to renderer
      targetWindow.webContents.send('tray:navigate-to-session', { sessionId, workspacePath });
    } else {
      // No window for this workspace -- just show any window
      const windows = projectWindows();
      if (windows.length > 0) {
        windows[0].show();
        windows[0].focus();
      }
    }

    // Clear unread flag when user clicks (in-memory + database)
    void this.markSessionsRead([{ sessionId, workspacePath }]);
  }

  /**
   * Clear every unread session from the tray in one action.
   */
  async clearAllUnreadSessions(): Promise<void> {
    const unreadSessions = Array.from(this.sessionCache.values())
      .filter((session) => session.hasUnread && session.workspacePath)
      .map((session) => ({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
      }));

    if (unreadSessions.length === 0) return;

    await this.markSessionsRead(unreadSessions);
  }

  /**
   * Apply read-state updates consistently for tray actions:
   * - clear in-memory unread state
   * - persist hasUnread/lastReadAt
   * - fan out a renderer notification so open windows update immediately
   */
  private async markSessionsRead(
    sessions: Array<{ sessionId: string; workspacePath: string }>
  ): Promise<void> {
    if (sessions.length === 0) return;

    const lastReadAt = Date.now();
    const rendererPayload: TrayUnreadClearPayload = {
      sessions: sessions.map((session) => ({
        ...session,
        lastReadAt,
      })),
    };

    for (const session of sessions) {
      this.applyReadStateToCache(session.sessionId);
    }
    this.scheduleMenuRebuild();
    this.broadcastUnreadCleared(rendererPayload);

    await Promise.all(
      sessions.map((session) => this.persistReadState(session.sessionId, lastReadAt))
    );
  }

  private applyReadStateToCache(sessionId: string): void {
    const session = this.sessionCache.get(sessionId);
    if (!session) return;

    session.hasUnread = false;
    if ((session.status === 'completed' || session.status === 'idle') && !session.hasPendingPrompt) {
      this.sessionCache.delete(sessionId);
      this.clearLingerTimer(sessionId);
    }
  }

  private broadcastUnreadCleared(payload: TrayUnreadClearPayload): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('tray:clear-unread', payload);
    }
  }

  /**
   * Persist hasUnread = false and lastReadAt so tray clears match renderer semantics.
   */
  private async persistReadState(sessionId: string, lastReadAt: number): Promise<void> {
    const syncProvider = getSyncProvider();

    try {
      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          hasUnread: false,
          lastReadAt,
        },
      });
      if (syncProvider) {
        const outcome = await syncProvider.pushChange(sessionId, {
          type: 'metadata_updated',
          metadata: { lastReadAt },
        });
        warnIfUnpublished(message => logger.main.warn(message), sessionId, '[TrayManager] Failed to publish read state', outcome);
      }
    } catch (error) {
      logger.main.error('[TrayManager] Failed to persist read state from tray action:', error);
    }
  }

  // ─── Database queries ─────────────────────────────────────────────────

  /**
   * Query the database for sessions that already have hasUnread = true and
   * seed the session cache. Without this, sessions that completed before this
   * app session started would never appear in the tray's "Unread" section.
   */
  private async seedUnreadFromDatabase(): Promise<void> {
    if (!this.database) return;

    try {
      // One row over the cap, so the log can say whether it truncated.
      const { rows } = await this.database.query<any>(unreadSeedQuery(UNREAD_SEED_LIMIT + 1));
      const seeded = rows.slice(0, UNREAD_SEED_LIMIT);

      for (const row of seeded) {
        // Don't overwrite sessions already in cache (e.g., currently running)
        if (this.sessionCache.has(row.id)) continue;

        const metadata = parseMetadataColumn(row.metadata);
        this.sessionCache.set(row.id, {
          sessionId: row.id,
          title: row.title || 'Untitled Session',
          workspacePath: row.workspace_id || '',
          status: 'completed',
          isStreaming: false,
          // Don't inherit stale hasPendingPrompt from old metadata --
          // a completed session that's merely unread isn't blocked on user input.
          hasPendingPrompt: false,
          hasUnread: true,
          provider: row.provider || 'claude',
          model: row.model || undefined,
          updatedAt: toMillis(row.updated_at),
          phase: typeof metadata.phase === 'string' ? metadata.phase : undefined,
          isArchived: false,
        });
      }

      if (seeded.length > 0) {
        // The truncation is logged because the strip's unread count is drawn
        // from the cache: past the cap it stops being the fleet's real number,
        // and a capped count that says so is recoverable where a silent one is
        // just wrong.
        const truncated = rows.length > UNREAD_SEED_LIMIT ? ` (capped at ${UNREAD_SEED_LIMIT})` : '';
        logger.main.info(`[TrayManager] Seeded ${seeded.length} unread session(s) from database${truncated}`);
        this.scheduleMenuRebuild();
      }
    } catch (error) {
      logger.main.error('[TrayManager] Failed to seed unread sessions from database:', error);
    }

    // The idle panel reports how long it has been quiet, and "since this app
    // launched" is not that. One aggregate read gives it an honest starting
    // point. It feeds the panel header only -- never the strip.
    try {
      const { rows } = await this.database.query<{ last_activity: unknown }>(
        `SELECT MAX(updated_at) AS last_activity FROM ai_sessions WHERE is_archived = false`,
      );
      const seeded = rows[0]?.last_activity;
      if (seeded !== null && seeded !== undefined) {
        this.lastFleetActivityAt = toMillis(seeded);
      }
    } catch (error) {
      logger.main.error('[TrayManager] Failed to seed last fleet activity from database:', error);
    }
  }

  private async fetchSessionMetadata(sessionId: string): Promise<TraySessionInfo> {
    if (!this.database) {
      return this.createFallbackSession(sessionId);
    }

    try {
      const { rows } = await this.database.query<any>(
        `SELECT id, title, workspace_id, provider, model, updated_at, is_archived, metadata
         FROM ai_sessions WHERE id = $1`,
        [sessionId]
      );

      if (rows.length === 0) {
        return this.createFallbackSession(sessionId);
      }

      const row = rows[0];
      const metadata = parseMetadataColumn(row.metadata);

      return {
        sessionId,
        title: row.title || 'Untitled Session',
        workspacePath: row.workspace_id || '',
        status: 'running',
        isStreaming: false,
        hasPendingPrompt: !!metadata.hasPendingPrompt,
        hasUnread: !!metadata.hasUnread,
        provider: row.provider || 'claude',
        model: row.model || undefined,
        updatedAt: toMillis(row.updated_at),
        phase: typeof metadata.phase === 'string' ? metadata.phase : undefined,
        isArchived: !!row.is_archived,
      };
    } catch (error) {
      // Database query failure is not fatal -- title is cosmetic
      logger.main.error(`[TrayManager] Failed to fetch session metadata for ${sessionId}:`, error);
      return this.createFallbackSession(sessionId);
    }
  }

  private createFallbackSession(sessionId: string): TraySessionInfo {
    return {
      sessionId,
      title: 'AI Session',
      workspacePath: '',
      status: 'running',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: false,
      provider: 'claude',
      updatedAt: Date.now(),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private truncateTitle(title: string, maxLen: number = 40): string {
    if (title.length <= maxLen) return title;
    return title.slice(0, maxLen - 1) + '\u2026';
  }

  private getRunningCount(): number {
    let count = 0;
    for (const session of this.sessionCache.values()) {
      if (session.status === 'running') count++;
    }
    return count;
  }

  private getAttentionCount(): number {
    let count = 0;
    for (const session of this.sessionCache.values()) {
      if (session.hasPendingPrompt || session.hasUnread || session.status === 'error') count++;
    }
    return count;
  }

  private startLingerTimer(sessionId: string): void {
    this.clearLingerTimer(sessionId);
    const timer = setTimeout(() => {
      this.lingerTimers.delete(sessionId);
      const session = this.sessionCache.get(sessionId);
      // Only remove if still in completed state and not unread
      if (session && session.status === 'completed' && !session.hasUnread && !session.hasPendingPrompt) {
        this.sessionCache.delete(sessionId);
        this.scheduleMenuRebuild();
      }
    }, COMPLETED_LINGER_MS);
    this.lingerTimers.set(sessionId, timer);
  }

  private clearLingerTimer(sessionId: string): void {
    const timer = this.lingerTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.lingerTimers.delete(sessionId);
    }
  }
}
