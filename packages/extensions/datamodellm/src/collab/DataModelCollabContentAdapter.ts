/**
 * DataModelLM CollabContentAdapter
 *
 * The DataModel Y.Doc shape is keyed entity / relationship maps
 * (Pattern B in COLLABORATION_GUIDE.md). Projection back to disk
 * goes via `serializeToPrismaSchema` so re-upload, history-restore,
 * export-to-file, and toPlainText all produce a valid Prisma
 * schema string.
 *
 * `layoutVersion` mirrors the in-Y.Doc `meta.version` -- bump
 * together with the seed when the Y.Doc layout changes.
 */
import * as Y from 'yjs';
import type { CollabContentAdapter } from '@nimbalyst/extension-sdk';
import { serializeToPrismaSchema } from '../prismaParser';
import type {
  DataModelFile,
  Database,
  Entity,
  EntityViewMode,
  Relationship,
} from '../types';
import {
  isDataModelYDocEmpty,
  seedDataModelYDoc,
  Y_ENTITIES_KEY,
  Y_META_KEY,
  Y_RELATIONSHIPS_KEY,
} from './seed';
import { yMapToEntity, yMapToRelationship } from './datamodelBinding';

function projectFile(yDoc: Y.Doc): DataModelFile {
  const yEntities = yDoc.getMap<Y.Map<unknown>>(Y_ENTITIES_KEY);
  const yRelationships = yDoc.getMap<Y.Map<unknown>>(Y_RELATIONSHIPS_KEY);
  const yMeta = yDoc.getMap<unknown>(Y_META_KEY);

  const entities: Entity[] = [];
  yEntities.forEach((yEntity) => { entities.push(yMapToEntity(yEntity)); });

  const relationships: Relationship[] = [];
  yRelationships.forEach((yRel) => { relationships.push(yMapToRelationship(yRel)); });

  const database = (yMeta.get('database') as Database) ?? 'postgres';
  const entityViewMode = (yMeta.get('entityViewMode') as EntityViewMode) ?? 'standard';

  return {
    version: 1,
    database,
    entities,
    relationships,
    // Viewport is per-client and not stored in the Y.Doc; default
    // for export.
    viewport: { x: 0, y: 0, zoom: 1 },
    entityViewMode,
  };
}

export const DataModelCollabContentAdapter: CollabContentAdapter = {
  documentType: 'datamodel',
  fileExtensions: ['.prisma'],
  mimeType: 'text/plain',
  layoutVersion: 1,

  isEmpty(yDoc) {
    return isDataModelYDocEmpty(yDoc);
  },

  seedFromFile(yDoc, source) {
    yDoc.transact(() => {
      seedDataModelYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer);
    });
  },

  applyFromFile(yDoc, source) {
    yDoc.transact(() => {
      const yEntities = yDoc.getMap<Y.Map<unknown>>(Y_ENTITIES_KEY);
      const yRelationships = yDoc.getMap<Y.Map<unknown>>(Y_RELATIONSHIPS_KEY);
      const yMeta = yDoc.getMap<unknown>(Y_META_KEY);
      yEntities.forEach((_, key) => yEntities.delete(key));
      yRelationships.forEach((_, key) => yRelationships.delete(key));
      yMeta.forEach((_, key) => yMeta.delete(key));
      seedDataModelYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer);
    });
  },

  exportToFile(yDoc) {
    return serializeToPrismaSchema(projectFile(yDoc));
  },

  toPlainText(yDoc) {
    return serializeToPrismaSchema(projectFile(yDoc));
  },
};
