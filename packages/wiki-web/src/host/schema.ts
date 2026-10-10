/**
 * The wiki's type definitions in the tracker registry the UI reads.
 *
 * The UI's selectors read the process-wide registry, which the bundle fills
 * through `BrowserTrackerSchemaStore`. That store refuses `sharing: personal`
 * types (no team room carries them), so local types are registered with the
 * team lane's sharing; nothing here talks to a team.
 */
import { BrowserTrackerSchemaStore, parseBuiltinTrackers } from '@nimbalyst/collab-bundle/trackers-ui';
import type { WikiTypeInfo } from '../api/client';

function modelJson(type: WikiTypeInfo): string {
  const definition = type.definition ?? {};
  const fields = Array.isArray(definition.fields) ? definition.fields : type.fields;
  return JSON.stringify({
    icon: 'label',
    color: '#6b7280',
    ...definition,
    type: type.typeId,
    displayName: type.displayName,
    displayNamePlural: type.displayNamePlural,
    fields,
    roles: { ...((definition.roles as Record<string, unknown> | undefined) ?? {}), title: type.titleField },
    modes: { inline: true, fullDocument: type.storage === 'pages' },
    idPrefix: typeof definition.idPrefix === 'string' ? definition.idPrefix : type.typeId.slice(0, 3),
    idFormat: 'ulid',
    sharing: 'team',
  });
}

export async function loadWikiSchema(types: readonly WikiTypeInfo[]): Promise<BrowserTrackerSchemaStore> {
  const store = new BrowserTrackerSchemaStore({
    builtins: parseBuiltinTrackers(),
    reportError: (error, where) => console.error(`[wiki-web] ${where}`, error),
  });
  for (const type of types) {
    await store.schemaSync.applyRemote({ type: type.typeId, model: modelJson(type), syncId: 0 });
  }
  return store;
}
