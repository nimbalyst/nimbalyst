export interface CollabBackupSweepSummary {
  success: boolean;
  orgId: string;
  projectId: string | null;
  total: number;
  backedUp: number;
  skipped: number;
  failures: Array<{ documentId: string; error: string }>;
}

export function requireSuccessfulCollabBackups(
  summaries: CollabBackupSweepSummary[],
): Array<string | null> {
  const projectIds: Array<string | null> = [];
  for (const summary of summaries) {
    projectIds.push(summary.projectId);
    if (summary.success) continue;
    const firstFailure = summary.failures[0];
    throw new Error(
      `Encryption migration blocked: plaintext backup failed for ${summary.failures.length} ` +
      `of ${summary.total} collaborative items` +
      (firstFailure ? ` (${firstFailure.documentId}: ${firstFailure.error})` : '') + '.',
    );
  }
  return projectIds;
}

export async function verifyOrMarkCollabBackups(
  summaries: CollabBackupSweepSummary[],
  markNeedsRecovery: (projectIds: Array<string | null>, reason: string) => Promise<void>,
): Promise<Array<string | null>> {
  try {
    return requireSuccessfulCollabBackups(summaries);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNeedsRecovery(summaries.map((summary) => summary.projectId), reason);
    throw error;
  }
}

