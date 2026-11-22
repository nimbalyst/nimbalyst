import type { TeamRecoveryDiagnostics, TeamRecoveryOperation } from '@nimbalyst/collab-protocol';

export interface TeamRecoveryOverview {
  orgId: string;
  diagnostics: TeamRecoveryDiagnostics | null;
  counts: { projects: number; items: number; documents: number; attachments: number };
  blockers: Array<{ id: string; reason: string }>;
  /** Content-free problems that do not block recovery by themselves, such as an unreadable retained key file. */
  notices: Array<{ id: string; reason: string }>;
  ready: boolean;
  saved: boolean;
  artifactName: string | null;
  operation: TeamRecoveryOperation | null;
  independentClient: boolean;
  identityAssignments: Array<{ projectId: string; itemId: string; issueKey: string | null; existing: boolean }>;
}
export type TeamRecoveryCommand = 'inspect' | 'collect' | 'save' | 'import' | 'restore' | 'verify' | 'status' | 'reset' | 'export-diagnostics' | 'release';
/** Only these unlock or write a recovery bundle; the renderer sends the passphrase to nothing else. */
export const TEAM_RECOVERY_PASSPHRASE_COMMANDS: ReadonlySet<TeamRecoveryCommand> = new Set(['save', 'import', 'restore', 'verify']);
