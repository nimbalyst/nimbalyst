/**
 * CommitTrackerLinker — Links git commits to tracker items.
 *
 * Three linking mechanisms:
 * 1. Session-based: After proposal-widget commits, links to session's tracker items
 * 2. Issue key parsing: Parses NIM-123 from any commit message detected by GitRefWatcher
 * 3. Auto-close: Fixes/Closes/Resolves keywords move the item to whichever status
 *    its own type completes on (see `trackerStatusCategory`)
 *
 * The passive GitRefWatcher path is opt-in (`enabled`, per-project overridable),
 * because it reacts to every commit in the repo including ones no agent was part
 * of. The session path is not: the user linked the session to the item and then
 * approved a commit message that says it closes the item, which is as explicit a
 * sign-off as exists. Only `autoCloseOnCommit` gates it.
 */

import { execFile } from 'child_process';
import Store from 'electron-store';
import { logger } from '../utils/logger';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import { isLocalIssueKey } from '../../shared/localIssueKey';
import type { CommitDetectedEvent } from '../file/GitRefWatcher';
import type { TrackerAutomationSettings } from '../utils/store';
import { getEffectiveTrackerAutomation } from '../utils/store';
import { getCurrentIdentity } from './TrackerIdentityService';
import { appendActivity } from './tracker/trackerActivity';
import type { LinkedCommit } from '@nimbalyst/runtime';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import {
  getDoneStatusValue,
  getWorkflowStatusFieldName,
  isTerminalStatus,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerStatusCategory';

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

    // A provisional local key is not a real issue reference -- it exists only
    // until the tracker room acks the item and hands back its own key. Closing
    // an item off one would resolve to whatever LC-### happens to be unclaimed
    // in the reader's workspace.
    if (isLocalIssueKey(issueKey)) {
      continue;
    }

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
// Commit author
// ---------------------------------------------------------------------------

/**
 * Read a commit's author name and email. The callback form of `execFile` is
 * used rather than `promisify` so a mocked `execFile` still sees the call.
 */
function readCommitAuthor(
  workspacePath: string,
  commitHash: string,
): Promise<{ name: string; email: string } | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', '-s', '--format=%an%n%ae', commitHash],
      { cwd: workspacePath },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const [name = '', email = ''] = String(stdout).split('\n').map((line) => line.trim());
        resolve(name || email ? { name, email } : null);
      },
    );
  });
}

function sameEmail(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

/**
 * Who to attribute a commit-driven activity entry to.
 *
 * The local identity wins whenever the commit's author is this machine's git
 * user: it carries the signed-in email and display name, which is what every
 * other activity writer stamps, so the entry coalesces and filters with them.
 * A commit by anyone else is attributed to its author from git, and a commit
 * whose author cannot be read at all falls back to the local identity rather
 * than going unattributed.
 */
async function resolveCommitAuthorIdentity(
  workspacePath: string,
  commitHash: string,
): Promise<TrackerIdentity> {
  const local = getCurrentIdentity(workspacePath);
  const author = await readCommitAuthor(workspacePath, commitHash);
  if (!author) return local;
  if (sameEmail(author.email, local.gitEmail) || sameEmail(author.email, local.email)) {
    return local;
  }
  return {
    email: author.email || null,
    displayName: author.name || author.email,
    gitName: author.name || null,
    gitEmail: author.email || null,
  };
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

    // logger.main.info(`[CommitTrackerLinker] Commit detected: ${event.commitHash.slice(0, 7)} in ${event.workspacePath}`);

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
   *
   * A closing keyword in the approved message ("Fixes NIM-123") also promotes
   * that item to `done`. An agent may not write `done` itself, so without this
   * every finished bug stalls in `in-review` even after the user has reviewed
   * the diff and committed it. A bare `NIM-123` still only links.
   *
   * @returns ids of the items this commit closed (empty when it closed none)
   */
  async linkBySession(
    commitHash: string,
    commitMessage: string,
    sessionId: string,
    workspacePath: string,
  ): Promise<{ closedItemIds: string[] }> {

    const db = this.getDb();
    if (!db) return { closedItemIds: [] };

    try {
      // Look up session's linked tracker items
      const sessionResult = await db.query(
        `SELECT metadata FROM ai_sessions WHERE id = $1`,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) return { closedItemIds: [] };

      // SQLite returns metadata as a raw JSON string (NIM-829); an unparsed
      // read sees no linked items and session-based commit linking no-ops.
      const metadata = parseJsonObjectColumn(sessionResult.rows[0].metadata);
      const linkedTrackerItemIds: string[] = Array.isArray(metadata.linkedTrackerItemIds)
        ? metadata.linkedTrackerItemIds
        : [];
      // Skip file: references (these are plan file links, not tracker item IDs)
      const trackerIds = linkedTrackerItemIds.filter((id) => !id.startsWith('file:'));
      if (trackerIds.length === 0) return { closedItemIds: [] };

      const commit: LinkedCommit = {
        sha: commitHash,
        message: commitMessage.split('\n')[0], // first line only
        sessionId,
        timestamp: new Date().toISOString(),
      };

      for (const trackerId of trackerIds) {
        await this.appendCommitToItem(trackerId, commit, workspacePath);
      }

      if (!this.getSettings(workspacePath).autoCloseOnCommit) {
        return { closedItemIds: [] };
      }

      const closingKeys = new Set(
        parseIssueKeys(commitMessage)
          .filter((match) => match.shouldClose)
          .map((match) => match.issueKey),
      );
      if (closingKeys.size === 0) return { closedItemIds: [] };

      const closedItemIds = await this.resolveClosableIds(trackerIds, closingKeys, workspacePath);
      for (const itemId of closedItemIds) {
        await this.closeTrackerItem(itemId, commitHash, workspacePath);
      }
      return { closedItemIds };
    } catch (error) {
      logger.main.error('[CommitTrackerLinker] Error linking by session:', error);
      return { closedItemIds: [] };
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
   * Of the session's linked items, which ones does this message name with a
   * closing keyword. One query rather than one per linked id -- a long-running
   * session can accumulate a lot of linked items.
   */
  private async resolveClosableIds(
    trackerIds: string[],
    closingKeys: Set<string>,
    workspacePath: string,
  ): Promise<string[]> {
    const db = this.getDb();
    if (!db) return [];

    const placeholders = trackerIds.map((_, index) => `$${index + 2}`).join(', ');
    const result = await db.query(
      `SELECT id, issue_key FROM tracker_items
       WHERE workspace = $1 AND id IN (${placeholders})`,
      [workspacePath, ...trackerIds]
    );

    return (result.rows as Array<{ id: string; issue_key?: string | null }>)
      .filter((row) => typeof row.issue_key === 'string' && closingKeys.has(row.issue_key.toUpperCase()))
      .map((row) => row.id);
  }

  /**
   * Close a tracker item via a commit closing keyword.
   *
   * The status written is the one the item's OWN type closes into, not the
   * literal `'done'`. Every type ends on a different value -- a plan on
   * `completed`, a release on `released` -- so hardcoding `'done'` stamped a
   * status that was not in the type's option list at all, surviving only
   * because the validator downgrades unknown select values to warnings.
   */
  private async closeTrackerItem(
    itemId: string,
    commitHash: string,
    workspacePath: string,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    const result = await db.query(
      `SELECT type, data FROM tracker_items WHERE id = $1 AND workspace = $2`,
      [itemId, workspacePath]
    );
    if (result.rows.length === 0) return;

    const data = typeof result.rows[0].data === 'string'
      ? JSON.parse(result.rows[0].data)
      : result.rows[0].data || {};

    const type = String(result.rows[0].type ?? data.type ?? '');
    const statusField = getWorkflowStatusFieldName(type);
    const oldStatus = data[statusField];

    // Already terminal -- including cancelled. A commit must not reopen an
    // abandoned item by "closing" it.
    if (isTerminalStatus(type, oldStatus)) return;

    const closingStatus = getDoneStatusValue(type);
    if (!closingStatus) {
      // A type with no done-category status (an idea ends cancelled or
      // converted, never "done") cannot be closed by a commit. Leaving the
      // status alone is right; inventing one is how the out-of-schema write
      // this method used to make got started.
      logger.main.info(
        `[CommitTrackerLinker] ${itemId} (${type}) has no completed status; leaving it open`,
      );
      return;
    }

    data[statusField] = closingStatus;

    // Through the shared writer, never a raw push: sync merges the trail on
    // entry `id` and sorts on a numeric `timestamp`, so a hand-built entry
    // collapses with its siblings the first time the item syncs.
    appendActivity(data, await resolveCommitAuthorIdentity(workspacePath, commitHash), 'status_changed', {
      field: statusField,
      oldValue: oldStatus,
      newValue: closingStatus,
      note: `Closed via commit ${commitHash.slice(0, 7)}`,
    });

    await db.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), itemId]
    );

    logger.main.info(`[CommitTrackerLinker] Auto-closed ${itemId} via commit ${commitHash.slice(0, 7)}`);
  }
}

/** Singleton instance */
export const commitTrackerLinker = new CommitTrackerLinker();
