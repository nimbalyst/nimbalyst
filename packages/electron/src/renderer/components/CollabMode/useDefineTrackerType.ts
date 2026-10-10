/**
 * The desktop write behind Pages "New type...": the schema goes to main, which
 * runs the same define-type path the agent tool uses (team schemas write
 * through to the room, personal ones stay local). Resolves once this window's
 * registry has the type, so the section's Set type list can offer it. A team
 * type waits in main for the room's answer: a lost race rejects, and an answer
 * that has not come in time resolves `{ status: 'syncing' }`.
 */
import { useCallback } from 'react';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { NewTypeSchema } from '@nimbalyst/collab-client/docs-ui/setPageType';

/** How long to wait for the schema broadcast before trusting main's success. */
const REGISTRY_WAIT_MS = 5000;

interface DefineTypeApi {
  defineType: (payload: { workspacePath: string; schema: Record<string, unknown> }) =>
    Promise<{ success: boolean; type?: string; status?: 'created' | 'syncing'; error?: string }>;
}

interface TypeRegistry {
  get(type: string): unknown;
  onChange(fn: () => void): () => void;
}

export async function defineTrackerTypeOverIpc(
  api: DefineTypeApi,
  registry: TypeRegistry,
  workspacePath: string,
  schema: NewTypeSchema | { type: string },
): Promise<void | { status: 'syncing' }> {
  const result = await api.defineType({ workspacePath, schema: schema as unknown as Record<string, unknown> });
  if (!result.success) throw new Error(result.error || `Could not create type '${schema.type}'.`);
  const type = result.type ?? schema.type;
  // A team type the room has not confirmed yet: the dialog says so instead of success.
  const outcome = result.status === 'syncing' ? { status: 'syncing' as const } : undefined;
  if (registry.get(type)) return outcome;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, REGISTRY_WAIT_MS);
    const unsubscribe = registry.onChange(() => {
      if (registry.get(type)) finish();
    });
  });
  return outcome;
}

export function useDefineTrackerType(workspacePath: string): (schema: NewTypeSchema) => Promise<void | { status: 'syncing' }> {
  return useCallback(
    (schema: NewTypeSchema) =>
      defineTrackerTypeOverIpc(window.electronAPI.trackerLifecycle, globalRegistry, workspacePath, schema),
    [workspacePath],
  );
}
