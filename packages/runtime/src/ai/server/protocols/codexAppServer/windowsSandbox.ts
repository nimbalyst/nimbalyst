export type WindowsSandboxMode = 'elevated' | 'unelevated';
export type WindowsSandboxReadiness = 'ready' | 'notConfigured' | 'updateRequired';
export interface WindowsSandboxState {
  phase: 'idle' | 'running' | 'error';
  readiness?: WindowsSandboxReadiness;
  allowedModes?: WindowsSandboxMode[];
  error?: string;
}

let setupGeneration = 0;
export function codexSandboxSetupCompleted(): void { setupGeneration++; }
export function getCodexSandboxGeneration(): number { return setupGeneration; }

export function codexSessionConfigurationKey(mode: string | null | undefined, verified: boolean, cwd: string, roots: string[]): string {
  // #1544: cached children must not retain roots or sandbox setup from a prior turn.
  return JSON.stringify([mode, verified, cwd, [...new Set(roots)].sort(), setupGeneration]);
}
