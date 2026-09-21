import type { DataModelFile } from '../types';
import { serializeToPrismaSchema } from '../prismaParser';

function schemaKey(model: DataModelFile): string {
  return JSON.stringify({
    database: model.database,
    entities: model.entities.map(
      ({ position: _position, ...entity }) => entity
    ),
    relationships: model.relationships,
  });
}

/** A diagram-only save must not rewrite Prisma syntax the parser doesn't model. */
export function createLayoutSerializer() {
  let source: string | undefined;
  let capturedSchema: string | undefined;
  return {
    capture(raw: string, parsed: DataModelFile) {
      source = raw;
      capturedSchema = schemaKey(parsed);
    },
    serialize(model: DataModelFile): string {
      if (source === undefined || capturedSchema !== schemaKey(model))
        return serializeToPrismaSchema(model);
      const metadata =
        '// @nimbalyst ' +
        JSON.stringify({
          viewport: model.viewport,
          positions: Object.fromEntries(
            model.entities.map((entity) => [entity.name, entity.position])
          ),
          entityViewMode: model.entityViewMode,
        });
      const existing = /^\/\/ @nimbalyst [^\r\n]*/m;
      if (existing.test(source))
        return source.replace(existing, () => metadata);
      return metadata + (source.includes('\r\n') ? '\r\n' : '\n') + source;
    },
  };
}
