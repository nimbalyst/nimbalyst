/**
 * Codex approval requests (#1884): mapping Nimbalyst permission answers onto
 * the app-server's v2 decisions, and the text shown when Codex reports an item
 * as `declined`.
 */
import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  ItemCommandExecutionRequestApprovalParams,
  ItemPermissionsRequestApprovalParams,
  PermissionsApprovalResponse,
} from './types';

/** Codex sends no output or reason on a declined item; this is what the transcript shows. */
export const DECLINED_COMMAND_RESULT = 'Command not run: the approval request was declined.';
export const DECLINED_FILE_CHANGE_RESULT = 'Edit not applied: the approval request was declined.';

/** The subset of a Nimbalyst permission answer these mappings read. */
export interface CodexPermissionAnswer {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always' | 'always-all';
}

/**
 * The command a person would recognize. Codex wraps commands in a shell
 * (`/bin/zsh -lc '...'`, PowerShell on Windows); when it parsed exactly one
 * inner command, prompt and match patterns on that.
 */
export function codexApprovalCommandText(params: ItemCommandExecutionRequestApprovalParams): string {
  const actions = params.commandActions ?? [];
  if (actions.length === 1 && actions[0].command) return actions[0].command;
  return params.command ?? '';
}

const SHELL_WRAPPER = /^\s*(?:\S*[\\/])?(?:bash|zsh|sh|dash|fish|ksh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\S+\s+)*(?:-c|-lc|-Command|-EncodedCommand|-File|\/c|\/k)\b/i;

/**
 * True when the command is still wrapped in a shell. Its pattern would be the
 * shell itself (`Bash(powershell.exe:*)`), so remembering it would approve
 * every command that shell runs.
 */
export function isShellWrappedCommand(command: string): boolean {
  return SHELL_WRAPPER.test(command);
}

function isAvailable(
  params: ItemCommandExecutionRequestApprovalParams,
  name: 'accept' | 'acceptForSession' | 'acceptWithExecpolicyAmendment' | 'decline' | 'cancel',
): boolean {
  // Older servers omit the list; every decision is then allowed.
  if (!params.availableDecisions) return true;
  return params.availableDecisions.some((d) => (typeof d === 'string' ? d === name : name in d));
}

/**
 * "Always" also writes Codex's proposed exec-policy amendment when it offers
 * one, so Codex stops asking. Codex stores amendments in the user-level
 * `~/.codex/rules/default.rules`; the amendment is the exact command prefix it
 * proposed (for `rm -rf /some/path` that is the whole command), not a pattern.
 */
export function commandApprovalDecision(
  answer: CodexPermissionAnswer,
  params: ItemCommandExecutionRequestApprovalParams,
): CommandExecutionApprovalDecision {
  if (answer.decision !== 'allow') return 'decline';
  if (answer.scope === 'once') return 'accept';
  const amendment = params.proposedExecpolicyAmendment;
  if (
    (answer.scope === 'always' || answer.scope === 'always-all')
    && amendment && amendment.length > 0
    && isAvailable(params, 'acceptWithExecpolicyAmendment')
  ) {
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
  }
  // Nimbalyst remembers session and Always approvals itself, so a plain
  // accept is still answered without a prompt next time.
  return isAvailable(params, 'acceptForSession') ? 'acceptForSession' : 'accept';
}

export function fileChangeApprovalDecision(answer: CodexPermissionAnswer): FileChangeApprovalDecision {
  if (answer.decision !== 'allow') return 'decline';
  return answer.scope === 'once' ? 'accept' : 'acceptForSession';
}

/** Granting nothing declines; allowing grants exactly what was requested. */
export function permissionsApprovalResponse(
  answer: CodexPermissionAnswer,
  params: ItemPermissionsRequestApprovalParams,
): PermissionsApprovalResponse {
  if (answer.decision !== 'allow') return { permissions: {}, scope: 'turn' };
  const permissions: PermissionsApprovalResponse['permissions'] = {};
  if (params.permissions?.network) permissions.network = params.permissions.network;
  if (params.permissions?.fileSystem) permissions.fileSystem = params.permissions.fileSystem;
  return { permissions, scope: answer.scope === 'once' ? 'turn' : 'session' };
}
