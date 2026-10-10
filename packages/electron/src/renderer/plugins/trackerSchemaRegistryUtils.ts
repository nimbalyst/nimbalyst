import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime';

/**
 * Replace the workspace's schemas in the registry. `keepVocabulary` is for a
 * reload of the same workspace: the label and predicate registries stay in
 * force until the caller swaps in the fresh copy.
 */
export function applySchemasToRegistry(schemas: unknown[], options: { keepVocabulary?: boolean } = {}): void {
  globalRegistry.clearWorkspaceSchemas(options);

  if (!schemas.length) {
    loadBuiltinTrackers();
    return;
  }

  for (const schema of schemas as Parameters<typeof globalRegistry.register>[0][]) {
    globalRegistry.register(schema);
  }
}
