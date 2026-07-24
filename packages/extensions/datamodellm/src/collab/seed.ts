/**
 * Bootstrap seeding for the DatamodelLM collaborative Y.Doc.
 *
 * Called by `useCollaborativeEditor` when this client is the first to open a
 * `.prisma` collab document. The hook wraps this call in a
 * `yDoc.transact(..., COLLAB_INIT_ORIGIN)`, so the binding's observer can
 * recognise and ignore the seeding transaction.
 *
 * Bootstrap-race safety
 * ---------------------
 * Two clients can race here. Both observe an empty Y.Doc, both run the seed,
 * their CRDT updates merge. Without determinism the merged state has duplicate
 * entries.
 *
 * The parser (`parsePrismaSchema`) assigns nanoid ids to entities and fields
 * every time it runs, so we CANNOT use those ids directly. Instead we derive
 * stable ids from content:
 *
 *   - Entity id  = `e_${entity.name}`
 *   - Field id   = `f_${entity.name}__${field.name}`
 *   - Rel id     = `r_${src}__${tgt}__${srcField||''}__${tgtField||''}`
 *
 * These match Prisma's natural uniqueness rules (model names unique within a
 * schema; field names unique within a model). Two clients seeding from the
 * same file produce identical ids, so the CRDT merge collapses duplicates
 * into one shape.
 *
 * Y.Doc shape (Pattern B from COLLABORATION_GUIDE.md)
 * --------------------------------------------------
 *   entities       : Y.Map<entityId, Y.Map<unknown>>
 *     each entity Y.Map keys:
 *       id          : string  (mirror of the map key)
 *       name        : string
 *       description?: string
 *       color?      : string
 *       position    : { x: number; y: number }   (plain object, atomic replace)
 *       fields      : Field[]                    (plain array; each field has a stable id)
 *       indexes?    : Index[]                    (plain array)
 *   relationships  : Y.Map<relId, Y.Map<unknown>>
 *     each rel Y.Map keys: full Relationship object spread across keys
 *   meta           : Y.Map { database, entityViewMode, version }
 *
 * Position is stored as a single object rather than separate x/y keys so a
 * drag is one atomic update (concurrent drags last-write-wins). Fields are a
 * plain array rather than Y.Array<Y.Map> for v1 simplicity -- concurrent edits
 * to fields on the SAME entity will clobber each other, but edits to fields
 * on DIFFERENT entities merge cleanly. Viewport is intentionally NOT in the
 * Y.Doc: it's per-client state.
 */

import * as Y from 'yjs';
import { parsePrismaSchema } from '../prismaParser';
import type {
  DataModelFile,
  Entity,
  Field,
  Relationship,
} from '../types';

export const Y_ENTITIES_KEY = 'entities';
export const Y_RELATIONSHIPS_KEY = 'relationships';
export const Y_META_KEY = 'meta';
export const DOC_VERSION = 1;

/** Stable entity id derived from the entity name. */
export function entityStableId(name: string): string {
  return `e_${name}`;
}

/** Stable field id derived from entity + field name. */
export function fieldStableId(entityName: string, fieldName: string): string {
  return `f_${entityName}__${fieldName}`;
}

/** Stable relationship id derived from endpoint identity. */
export function relationshipStableId(rel: {
  sourceEntityName: string;
  targetEntityName: string;
  sourceFieldName?: string;
  targetFieldName?: string;
}): string {
  return `r_${rel.sourceEntityName}__${rel.targetEntityName}__${rel.sourceFieldName ?? ''}__${rel.targetFieldName ?? ''}`;
}

/**
 * Whether the Y.Doc has any DatamodelLM content yet. Used as the
 * `useCollaborativeEditor` `isEmpty` guard so we don't re-seed a doc that was
 * just sync'd in.
 *
 * The default byte-length check (`Y.encodeStateAsUpdate(yDoc).byteLength <= 2`)
 * would still consider an empty Y.Doc as empty here, but if a future code
 * path were to lazily allocate `meta`/`entities`/`relationships` containers
 * before seed runs, the byte-length check could spuriously fire. This custom
 * predicate checks actual content presence.
 */
export function isDataModelYDocEmpty(yDoc: Y.Doc): boolean {
  return (
    yDoc.getMap(Y_META_KEY).size === 0 &&
    yDoc.getMap(Y_ENTITIES_KEY).size === 0 &&
    yDoc.getMap(Y_RELATIONSHIPS_KEY).size === 0
  );
}

/** Decode an ArrayBuffer/string into a Prisma schema string. */
function decodeContent(content: string | ArrayBuffer): string {
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder().decode(content);
  } catch {
    return '';
  }
}

/**
 * Populate the Y.Doc from raw Prisma file content. MUST be called inside a
 * transaction with the SDK's `COLLAB_INIT_ORIGIN`.
 */
export function seedDataModelYDoc(yDoc: Y.Doc, content: string | ArrayBuffer): void {
  const text = decodeContent(content);
  const file: DataModelFile = text.trim()
    ? safeParse(text)
    : {
        version: 1,
        database: 'postgres',
        entities: [],
        relationships: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        entityViewMode: 'standard',
      };

  const yEntities = yDoc.getMap<Y.Map<unknown>>(Y_ENTITIES_KEY);
  const yRelationships = yDoc.getMap<Y.Map<unknown>>(Y_RELATIONSHIPS_KEY);
  const yMeta = yDoc.getMap<unknown>(Y_META_KEY);

  // Meta
  yMeta.set('database', file.database);
  yMeta.set('entityViewMode', file.entityViewMode);
  yMeta.set('version', DOC_VERSION);

  // Entities -- rewrite ids deterministically.
  for (const entity of file.entities) {
    const stableId = entityStableId(entity.name);
    // Guard against a concurrent client seeding the same key during the
    // CRDT-merge window. `set` on an existing Y.Map key would replace; we
    // only initialise if absent so a concurrent seed's edits aren't lost.
    if (yEntities.has(stableId)) continue;

    const yEntity = new Y.Map<unknown>();
    yEntity.set('id', stableId);
    yEntity.set('name', entity.name);
    if (entity.description !== undefined) {
      yEntity.set('description', entity.description);
    }
    if (entity.color !== undefined) {
      yEntity.set('color', entity.color);
    }
    yEntity.set('position', { x: entity.position.x, y: entity.position.y });
    yEntity.set('fields', stabiliseFieldIds(entity.name, entity.fields));
    if (entity.indexes) {
      yEntity.set('indexes', entity.indexes.map((idx) => ({ ...idx })));
    }
    yEntities.set(stableId, yEntity);
  }

  // Relationships -- rewrite ids deterministically.
  for (const rel of file.relationships) {
    const stableId = relationshipStableId(rel);
    if (yRelationships.has(stableId)) continue;

    const yRel = new Y.Map<unknown>();
    yRel.set('id', stableId);
    yRel.set('type', rel.type);
    yRel.set('sourceEntityName', rel.sourceEntityName);
    yRel.set('targetEntityName', rel.targetEntityName);
    if (rel.name !== undefined) yRel.set('name', rel.name);
    if (rel.sourceFieldName !== undefined) yRel.set('sourceFieldName', rel.sourceFieldName);
    if (rel.targetFieldName !== undefined) yRel.set('targetFieldName', rel.targetFieldName);
    if (rel.onDelete !== undefined) yRel.set('onDelete', rel.onDelete);
    if (rel.onUpdate !== undefined) yRel.set('onUpdate', rel.onUpdate);
    if (rel.implementationType !== undefined) yRel.set('implementationType', rel.implementationType);
    yRelationships.set(stableId, yRel);
  }
}

function safeParse(text: string): DataModelFile {
  try {
    return parsePrismaSchema(text);
  } catch {
    return {
      version: 1,
      database: 'postgres',
      entities: [],
      relationships: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      entityViewMode: 'standard',
    };
  }
}

/**
 * Rewrite field ids to the stable form. Other field properties pass through
 * unchanged. Nested embedded schemas are recursed so MongoDB type fields keep
 * their ids deterministic too.
 */
function stabiliseFieldIds(entityName: string, fields: Field[]): Field[] {
  return fields.map((f) => {
    const next: Field = { ...f, id: fieldStableId(entityName, f.name) };
    if (f.embeddedSchema) {
      next.embeddedSchema = stabiliseFieldIds(`${entityName}__${f.name}`, f.embeddedSchema);
    }
    return next;
  });
}

// Re-exported so the binding can read the same shape.
export type SeededRelationship = Relationship;
export type SeededEntity = Entity;
