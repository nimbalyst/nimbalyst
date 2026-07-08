/**
 * PR → tracker lifecycle writes for merges performed inside the PR view.
 *
 * Reference-based and type-agnostic: applies to every non-archived tracker
 * item referencing the merged PR (url-field match or explicit
 * linkedPullRequests entry). Behavior per item:
 *
 *   - Schema declares the `prMergedStatus` role → transition workflow status
 *     to that value (the maintainer clicked Merge; this is their action, not
 *     an agent's) and record a comment.
 *   - No role declared → record a comment only; never invent status
 *     semantics for a type that didn't opt in.
 *
 * Externally-merged/closed PRs are deliberately NOT handled here — those get
 * surfaced in the UI for the maintainer to act on, not auto-transitioned.
 */

import log from 'electron-log/main';
import { dbRowToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { globalRegistry, getRoleField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  getRecordStatus,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { getDatabase } from '../database/initialize';
import { ElectronDocumentService } from './ElectronDocumentService';
import { handleTrackerAddComment } from '../mcp/tools/trackerToolHandlers';

const logger = log.scope('PrTrackerLifecycle');

export async function applyPrMergeToTrackers(
  workspacePath: string,
  remote: string,
  prNumber: number,
): Promise<void> {
  const db = getDatabase();
  const wanted = remote.toLowerCase();

  const result = await db.query<any>(
    `SELECT * FROM tracker_items WHERE workspace = $1 AND archived IS NOT TRUE`,
    [workspacePath],
  );

  const referencing = result.rows
    .map((row: any) => dbRowToRecord(row))
    .filter((record) =>
      getRecordPrReferences(record).some((ref) => ref.remote === wanted && ref.number === prNumber),
    );

  if (referencing.length === 0) return;

  const docService = new ElectronDocumentService(workspacePath);

  for (const record of referencing) {
    try {
      const model = globalRegistry.get(record.primaryType);
      const mergedStatus = model ? getRoleField(model, 'prMergedStatus') : undefined;

      if (mergedStatus && getRecordStatus(record) !== mergedStatus) {
        const statusFieldName = resolveRoleFieldName(record.primaryType, 'workflowStatus');
        await docService.updateTrackerItem(record.id, { [statusFieldName]: mergedStatus });
        logger.info('PR merge → tracker status transition', {
          itemId: record.id,
          prNumber,
          status: mergedStatus,
        });
      }

      await handleTrackerAddComment(
        {
          trackerId: record.id,
          body: `PR #${prNumber} merged via the PR view (${new Date().toISOString().slice(0, 10)}).`,
        },
        workspacePath,
      );
    } catch (err) {
      logger.error('Failed to apply PR merge to tracker item', {
        itemId: record.id,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
