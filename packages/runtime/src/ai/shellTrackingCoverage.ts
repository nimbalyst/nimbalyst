/** Instrumentation health is separate from inferred file ownership. */
export const shellCoverageReasons = {
  missingPre: 'Tool ran without an acknowledged tracking hook',
  unmatchedTool: 'Tool tracking ended without a completion signal',
  staleEvent: 'Late or contradictory tool events were ignored',
  foreignTool: 'Hooks from another turn or a subagent were ignored',
  suspiciousWindow: 'A tool exceeded the previous age threshold',
  interrupted: 'Tracking was interrupted before its turn finished',
  unavailable: 'Shell tracking could not start',
  watcherLoss: 'The workspace file watcher was interrupted',
  hookFailure: 'A tracking hook could not be delivered',
  overlap: 'Earlier events were suppressed while ownership or tracking was uncertain',
  competingOwners: 'Edits made while another session was running a command were not linked',
  toolOverlap: 'Overlapping tools made ownership uncertain',
  observationGap: 'Events arrived during an interrupted tracking window',
  checkoutBaseline: 'Repository initialization could not be reconciled',
  initialization: 'Repository checkout files were excluded',
  // Recorded by earlier versions, which shared the link with the other session. No longer emitted.
  uninstrumented: 'Another agent session was active; links are shared, not exclusive',
  unreportedSession: 'Edits made while an agent session without tool tracking was active were not linked',
  overflow: 'Tracking exceeded its bounded capacity',
  throttled: 'File links could not be saved within the rate limit',
  quota: 'The session reached its file tracking limit',
  persistence: 'File links could not be saved',
  readFailure: 'Changed files could not be inspected',
  drainTimeout: 'Tracking did not finish draining',
  coveragePersistence: 'Tracking diagnostics could not be saved',
  excluded: 'Unsupported or excluded file events were skipped',
  knownWrite: 'Known editor writes were excluded',
} as const;
export type ShellCoverageReason = keyof typeof shellCoverageReasons;
export type ShellCoverageCounts = Partial<Record<ShellCoverageReason, number>>;
export interface ShellCoverageTurn {
  turnId: string;
  firstAt: number;
  lastAt: number;
  reasons: ShellCoverageCounts;
}
export interface ShellCoverageSummary {
  sessionId: string;
  state: 'unknown' | 'no-detected-fault' | 'degraded' | 'unavailable';
  reasons: ShellCoverageCounts;
  events?: Array<{
    reason: ShellCoverageReason; at: number; turnId?: string; toolUseId?: string;
    tool?: string; hookSessionId?: string; hookTurnId?: string; turnMatched?: boolean; agentType?: string;
    error?: string;
  }>;
  observation?: 'watching' | 'recovering';
  firstAt?: number;
  lastAt?: number;
  turns: ShellCoverageTurn[];
}
export function hasShellCoverageGap(reasons: ShellCoverageCounts): boolean {
  return Object.entries(reasons).some(
    ([reason, count]) => count && isShellCoverageFault(reason)
  );
}
/** Not instrumentation faults, but each one is a real change that was left unlinked. */
const WITHHELD_EDIT_REASONS: ReadonlySet<string> = new Set(['competingOwners', 'unreportedSession']);
export function shellCoverageDetails(coverage: ShellCoverageSummary[]): string[] {
  const reasons = new Set<ShellCoverageReason>();
  for (const item of coverage)
    for (const reason of Object.keys(item.reasons) as ShellCoverageReason[]) {
      if ((isShellCoverageFault(reason) || WITHHELD_EDIT_REASONS.has(reason)) && item.reasons[reason]) reasons.add(reason);
    }
  const details: string[] = [...reasons].map((reason) => shellCoverageReasons[reason]);
  if (coverage.some(item => item.observation === 'recovering')) details.unshift('File observation is currently interrupted');
  return details;
}

export function isShellCoverageFault(reason: string): boolean {
  // Cross-session ownership uncertainty is informational, not an instrumentation fault.
  return !['excluded', 'knownWrite', 'initialization', 'suspiciousWindow', 'uninstrumented', 'unreportedSession', 'foreignTool', 'competingOwners'].includes(reason);
}
