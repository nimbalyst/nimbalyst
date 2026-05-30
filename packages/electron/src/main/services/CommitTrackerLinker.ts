/**
 * CommitTrackerLinker — Links git commits to tracker items.
 *
 * Three linking mechanisms:
 * 1. Session-based: After proposal-widget commits, links to session's tracker items
 * 2. Issue key parsing: Parses NIM-123 from any commit message detected by GitRefWatcher
 * 3. Auto-close: Fixes/Closes/Resolves keywords change tracker item status to "done"
 *
 * All behaviors gated by TrackerAutomation settings (opt-in, per-project overridable).
 */

import Store from 'electron-store';
import { logger } from '../utils/logger';
import type { CommitDetectedEvent } from '../file/GitRefWatcher';
import type { TrackerAutomationSettings } from '../utils/store';
import { getEffectiveTrackerAutomation } from '../utils/store';
import type { LinkedCommit } from '@nimbalyst/runtime';

// ---------------------------------------------------------------------------
// Issue key parsing
// ---------------------------------------------------------------------------

export interface IssueKeyMatch {
  issueKey: string;       // e.g. "NIM-123"
  shouldClose: boolean;   // true if preceded by closing keyword
}

/**
 * Parse issue keys from a commit message.
 * Matches patterns like:
 * - NIM-123 (bare reference, link only)
 * - Fixes NIM-123, Closes NIM-123, Resolves NIM-123 (closing keywords)
 * - fix: NIM-123, fixed NIM-123, close NIM-123, etc.
 */
export function parseIssueKeys(commitMessage: string, prefix?: string): IssueKeyMatch[] {
  const matches: IssueKeyMatch[] = [];
  const seen = new Set<string>();

  // Match issue keys with optional closing keyword prefix
  // Closing keywords: fix, fixes, fixed, close, closes, closed, resolve, resolves, resolved
  const closingPattern = /(?:(fix(?:es|ed)?|close[sd]?|resolve[sd]?)[\s:]+)?([A-Z]+-\d+)/gi;

  let match: RegExpExecArray | null;
  while ((match = closingPattern.exec(commitMessage)) !== null) {
    const closingKeyword = match[1];
    const issueKey = match[2].toUpperCase();

    // If a prefix filter is provided, only match that prefix
    if (prefix && !issueKey.startsWith(prefix.toUpperCase() + '-')) {
      continue;
    }

    if (seen.has(issueKey)) continue;
    seen.add(issueKey);

    matches.push({
      issueKey,
      shouldClose: !!closingKeyword,
    });
  }

  return matches;
}

export function getIssueKeyPrefix(issueKey: string | null | undefined): string | undefined {
  if (typeof issueKey !== 'string') return undefined;

  const trimmed = issueKey.trim();
  if (trimmed.length === 0) return undefined;

  const separatorIndex = trimmed.indexOf('-');
  if (separatorIndex <= 0) return undefined;

  return trimmed.slice(0, separatorIndex).toUpperCase();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CommitTrackerLinker {
  private getDatabase: (() => any) | null = null;
  private settingsStore: Store<Record<string, unknown>> | null = null;

  /**
   * Initialize with lazy database accessor.
   * Called once during app startup.
   */
  initialize(deps: {
    getDatabase: () => any;
  }): void {
    this.getDatabase = deps.getDatabase;
  }

  private getAISettingsStore(): Store<Record<string, unknown>> {
    if (!this.settingsStore) {
      this.settingsStore = new Store({ name: 'ai-settings' });
    }
    return this.settingsStore;
  }

  /**
   * Handle a commit detected by GitRefWatcher.
   * This is the main entry point, registered as a commit listener.
   */
  async handleCommitDetected(event: CommitDetectedEvent): Promise<void> {
    const settings = this.getSettings(event.workspacePath);
    if (!settings.enabled) return;

    logger.main.info(`[CommitTrackerLinker] Commit detected: ${event.commitHash.slice(0, 7)} in ${event.workspacePath}`);

    // When enabled, always parse issue keys. Auto-close is gated separately.
    await this.linkByIssueKeys(event, settings);
  }

  /**
   * Link a commit to tracker items via session's linked tracker item IDs.
   * Called after a successful commit through the proposal widget.
   *
   * Always runs when a session has linked tracker items -- no opt-in required.
   * The user already explicitly linked the session to tracker items via tracker_link_session,
   * so linking the commit back is the expected, natural behavior.
   */
  async linkBySession(
    commitHash: string,
    commitMessage: string,
    sessionId: string,
    workspacePath: string,
  ): Promise<void> {

    const db = this.getDb();
    if (!db) return;

    try {
      // Look up session's linked tracker items
      const sessionResult = await db.query(
        `SELECT metadata FROM ai_sessions WHERE id = $1`,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) return;

      const metadata = sessionResult.rows[0].metadata;
      const linkedTrackerItemIds: string[] = metadata?.linkedTrackerItemIds ?? [];
      if (linkedTrackerItemIds.length === 0) return;

      const commit: LinkedCommit = {
        sha: commitHash,
        message: commitMessage.split('\n')[0], // first line only
        sessionId,
        timestamp: new Date().toISOString(),
      };

      for (const trackerId of linkedTrackerItemIds) {
        // Skip file: references (these are plan file links, not tracker item IDs)
        if (trackerId.startsWith('file:')) continue;
        await this.appendCommitToItem(trackerId, commit, workspacePath);
      }
    } catch (error) {
      logger.main.error('[CommitTrackerLinker] Error linking by session:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getSettings(workspacePath: string): TrackerAutomationSettings {
    const defaults: TrackerAutomationSettings = {
      enabled: false,
      autoCloseOnCommit: true,
    };
    const stored = this.getAISettingsStore().get('trackerAutomation', defaults) as TrackerAutomationSettings;
    const globalSettings: TrackerAutomationSettings = { ...defaults, ...stored };
    return getEffectiveTrackerAutomation(globalSettings, workspacePath);
  }

  private getDb(): any | null {
    try {
      return this.getDatabase?.() ?? null;
    } catch {
      return null;
    }
  }

  private async linkByIssueKeys(
    event: CommitDetectedEvent,
    settings: TrackerAutomationSettings,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    // Get the workspace issue key prefix
    const prefixResult = await db.query(
      `SELECT DISTINCT issue_key
       FROM tracker_items
       WHERE workspace = $1 AND issue_key IS NOT NULL
       ORDER BY issue_key ASC
       LIMIT 25`,
      [event.workspacePath]
    );
    const prefix = prefixResult.rows
      .map((row: { issue_key?: string | null }) => getIssueKeyPrefix(row.issue_key))
      .find((value: string | undefined): value is string => Boolean(value));

    const matches = parseIssueKeys(event.commitMessage, prefix);
    if (matches.length === 0) return;

    const commit: LinkedCommit = {
      sha: event.commitHash,
      message: event.commitMessage.split('\n')[0],
      timestamp: new Date().toISOString(),
    };

    for (const match of matches) {
      try {
        // Look up tracker item by issue_key
        const itemResult = await db.query(
          `SELECT id, data FROM tracker_items WHERE issue_key = $1 AND workspace = $2`,
          [match.issueKey, event.workspacePath]
        );

        if (itemResult.rows.length === 0) continue;

        const row = itemResult.rows[0];
        const itemId = row.id;

        await this.appendCommitToItem(itemId, commit, event.workspacePath);

        // Auto-close if closing keyword and setting enabled
        if (match.shouldClose && settings.autoCloseOnCommit) {
          await this.closeTrackerItem(itemId, event.commitHash, event.workspacePath);
        }
      } catch (error) {
        logger.main.error(`[CommitTrackerLinker] Error linking ${match.issueKey}:`, error);
      }
    }
  }

  /**
   * Append a commit to a tracker item's linkedCommits array.
   * Deduplicates by SHA. Caps at 50 entries.
   */
  private async appendCommitToItem(
    itemId: string,
    commit: LinkedCommit,
    workspacePath: string,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    const result = await db.query(
      `SELECT data FROM tracker_items WHERE id = $1 AND workspace = $2`,
      [itemId, workspacePath]
    );
    if (result.rows.length === 0) return;

    const data = typeof result.rows[0].data === 'string'
      ? JSON.parse(result.rows[0].data)
      : result.rows[0].data || {};

    const linkedCommits: LinkedCommit[] = data.linkedCommits || [];

    // Deduplicate by SHA
    if (linkedCommits.some((c: LinkedCommit) => c.sha === commit.sha)) return;

    linkedCommits.push(commit);

    // Cap at 50 (remove oldest)
    if (linkedCommits.length > 50) {
      linkedCommits.splice(0, linkedCommits.length - 50);
    }

    data.linkedCommits = linkedCommits;

    // Also keep linkedCommitSha in sync for backward compat (most recent)
    data.linkedCommitSha = commit.sha;

    await db.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), itemId]
    );

    logger.main.info(`[CommitTrackerLinker] Linked commit ${commit.sha.slice(0, 7)} to ${itemId}`);
  }

  /**
   * Set a tracker item's status to "done" via a commit closing keyword.
   */
  private async closeTrackerItem(
    itemId: string,
    commitHash: string,
    workspacePath: string,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    const result = await db.query(
      `SELECT data FROM tracker_items WHERE id = $1 AND workspace = $2`,
      [itemId, workspacePath]
    );
    if (result.rows.length === 0) return;

    const data = typeof result.rows[0].data === 'string'
      ? JSON.parse(result.rows[0].data)
      : result.rows[0].data || {};

    if (data.status === 'done') return; // Already closed

    const oldStatus = data.status;
    data.status = 'done';

    // Add activity log entry
    const activity: any[] = data.activity || [];
    activity.push({
      action: 'status_changed',
      field: 'status',
      oldValue: oldStatus,
      newValue: 'done',
      timestamp: new Date().toISOString(),
      note: `Closed via commit ${commitHash.slice(0, 7)}`,
    });
    // Cap activity at 100
    if (activity.length > 100) {
      activity.splice(0, activity.length - 100);
    }
    data.activity = activity;

    await db.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), itemId]
    );

    logger.main.info(`[CommitTrackerLinker] Auto-closed ${itemId} via commit ${commitHash.slice(0, 7)}`);
  }
}

/** Singleton instance */
export const commitTrackerLinker = new CommitTrackerLinker();
