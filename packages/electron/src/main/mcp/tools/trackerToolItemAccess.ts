import type { TrackerItem } from '@nimbalyst/runtime';
import { parseFullDocumentTrackerId } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { isLocalIssueKey, isLocalKeyReference } from '../../../shared/localIssueKey';
import type { ElectronDocumentService } from '../../services/ElectronDocumentService';

function assertTrackerReference(reference: unknown): asserts reference is string {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error('Tracker reference must be a non-empty string');
  }
}

export async function resolveTrackerRowByReference(
  db: { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> },
  reference: string,
  workspacePath?: string,
): Promise<any | null> {
  assertTrackerReference(reference);
  // Legacy provisional keys are not stable references. New items never
  // receive them, but refusing old values prevents a stale LC reference from
  // resolving to whichever historical row happens to carry it.
  if (isLocalIssueKey(reference)) {
    return null;
  }

  // A dotted local number means something different in every project on the
  // machine, and this table holds every workspace's rows. Resolving one
  // without knowing which project is how "have a look at NIM.4" picks the
  // wrong item -- so it resolves only when the caller names the workspace.
  if (isLocalKeyReference(reference)) {
    if (!workspacePath) return null;
    const localResult = await db.query<any>(
      `SELECT * FROM tracker_items
        WHERE local_key = $1 AND workspace = $2
        ORDER BY updated DESC
        LIMIT 1`,
      [reference.trim().toUpperCase(), workspacePath],
    );
    return localResult.rows[0] ?? null;
  }

  const params: any[] = [reference];
  const workspaceClause = workspacePath ? ` AND workspace = $2` : '';
  if (workspacePath) params.push(workspacePath);

  const result = await db.query<any>(
    `SELECT *
     FROM tracker_items
     WHERE (id = $1 OR issue_key = $1)${workspaceClause}
     ORDER BY updated DESC
     LIMIT 1`,
    params
  );

  if (result.rows[0]) {
    return result.rows[0];
  }

  const parsed = parseFullDocumentTrackerId(reference);
  if (!parsed) {
    return null;
  }

  const frontmatterParams: any[] = [parsed.relativePath, parsed.trackerType];
  const frontmatterWorkspaceClause = workspacePath ? ` AND workspace = $3` : '';
  if (workspacePath) frontmatterParams.push(workspacePath);
  const frontmatterResult = await db.query<any>(
    `SELECT *
     FROM tracker_items
     WHERE source = 'frontmatter'
       AND source_ref = $1
       AND type = $2${frontmatterWorkspaceClause}
     ORDER BY updated DESC
     LIMIT 1`,
    frontmatterParams
  );

  return frontmatterResult.rows[0] || null;
}

export async function getDocumentServiceForWorkspace(
  workspacePath: string | undefined,
): Promise<{
  docService: ElectronDocumentService | undefined;
  tempDocService: ElectronDocumentService | undefined;
}> {
  if (!workspacePath) {
    return { docService: undefined, tempDocService: undefined };
  }

  const { documentServices } = await import('../../window/WindowManager');
  return {
    docService: documentServices.get(workspacePath),
    tempDocService: undefined,
  };
}

export async function resolveTrackerItemFromDocumentService(
  docService: ElectronDocumentService | undefined,
  reference: string,
): Promise<TrackerItem | null> {
  assertTrackerReference(reference);
  if (!docService) return null;

  const byId = await docService.getTrackerItemById(reference);
  if (byId) return byId;

  const allItems = await docService.listTrackerItems();
  // Local numbers resolve here too. `resolveTrackerRowByReference` has matched
  // them since they were introduced; this path did not, so which references an
  // agent could read back depended on which lookup its tool happened to use.
  // The service is already workspace-scoped, so the ambiguity that gates the
  // database path does not arise.
  return allItems.find((candidate) => candidate.issueKey === reference
    || candidate.localKey === reference) || null;
}
