import type { JsonRpcClient } from './jsonRpcClient';
import type { SandboxMode } from './types';

/** #1544: the requested sandbox can differ from the effective Windows policy. */
export async function validateCodexSandbox(
  sandbox: unknown,
  requested: SandboxMode | null | undefined,
  client: Pick<JsonRpcClient, 'request'>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const effective = sandbox && typeof sandbox === 'object' && 'type' in sandbox ? sandbox.type : undefined;
  const expected = requested === 'danger-full-access' ? 'dangerFullAccess' : requested === 'read-only' ? 'readOnly' : 'workspaceWrite';
  if (effective === expected) return;
  if (effective === 'readOnly' && expected === 'workspaceWrite') {
    if (platform === 'win32') {
      const { requirements } = await client.request<{ requirements: { allowedSandboxModes?: string[] } | null }>('configRequirements/read', {});
      const allowed = requirements?.allowedSandboxModes;
      if (allowed && !allowed.includes('workspace-write')) {
        throw new Error('Codex is read-only because managed policy does not allow workspace writes. Contact your administrator to change the policy.');
      }
      const readiness = await client.request<{ status: string }>('windowsSandbox/readiness', {});
      if (readiness.status === 'notConfigured' || readiness.status === 'updateRequired') {
        throw new Error('Codex is read-only because Windows sandbox setup is required. Open Settings > OpenAI Codex, complete Windows sandbox setup, then retry this session.');
      }
    }
    throw new Error('Codex returned read-only permissions for a writable session. Check Codex configuration and managed policies, then retry this session.');
  }
  throw new Error(`Codex returned an incompatible sandbox policy (${String(effective)}; expected ${expected}). Check the installed Codex version and configuration before retrying this session.`);
}
