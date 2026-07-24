import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime';

export function applySchemasToRegistry(schemas: unknown[]): void {
  globalRegistry.clearWorkspaceSchemas();

  if (!schemas.length) {
    loadBuiltinTrackers();
    return;
  }

  for (const schema of schemas as Parameters<typeof globalRegistry.register>[0][]) {
    globalRegistry.register(schema);
  }
}
