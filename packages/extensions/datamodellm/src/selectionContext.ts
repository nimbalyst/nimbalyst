import type { EditorContextItem } from '@nimbalyst/extension-sdk';
import type { Database, Entity, Field, Relationship } from './types';

const TEXT_LIMIT = 240;
const MAX_FIELDS = 32;

function bounded(value: unknown, limit = TEXT_LIMIT): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function fieldSummary(field: Field): string {
  const flags = [
    field.isPrimaryKey ? 'primary key' : '',
    field.isForeignKey ? 'foreign key' : '',
    field.isNullable ? 'nullable' : '',
    field.isArray ? 'array' : '',
  ].filter(Boolean);
  return `${bounded(field.name, 120)}: ${bounded(field.dataType, 120)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

export function buildEntitySelectionContextItem(entity: Entity, database: Database): EditorContextItem {
  const fields = entity.fields.slice(0, MAX_FIELDS);
  const omitted = Math.max(0, entity.fields.length - fields.length);
  const safeFields = fields.map((field) => ({
    id: bounded(field.id, 160),
    name: bounded(field.name, 120),
    dataType: bounded(field.dataType, 120),
    isPrimaryKey: !!field.isPrimaryKey,
    isForeignKey: !!field.isForeignKey,
    isNullable: !!field.isNullable,
  }));
  const description = [
    `Selected ${database} schema entity "${bounded(entity.name, 160)}" (id ${bounded(entity.id, 200)}).`,
    `Position: (${Number.isFinite(entity.position.x) ? entity.position.x : 0}, ${Number.isFinite(entity.position.y) ? entity.position.y : 0}).`,
    entity.description ? `Description: ${bounded(entity.description, 600)}.` : '',
    `Fields (${entity.fields.length}): ${fields.map(fieldSummary).join('; ')}${omitted ? `; [${omitted} fields omitted]` : ''}.`,
    `Indexes: ${entity.indexes?.length ?? 0}.`,
  ].filter(Boolean).join(' ');
  return {
    id: `entity:${bounded(entity.id, 480)}`,
    label: bounded(entity.name || entity.id, 120),
    description,
    icon: 'table_chart',
    groupLabel: 'schema entities',
    data: {
      entityId: bounded(entity.id, 200),
      name: bounded(entity.name, 160),
      database,
      position: {
        x: Number.isFinite(entity.position.x) ? entity.position.x : 0,
        y: Number.isFinite(entity.position.y) ? entity.position.y : 0,
      },
      fields: safeFields,
      omittedFieldCount: omitted,
      indexCount: entity.indexes?.length ?? 0,
    },
    includeData: true,
  };
}

export function buildRelationshipSelectionContextItem(relationship: Relationship, database: Database): EditorContextItem {
  const source = bounded(relationship.sourceEntityName, 160);
  const target = bounded(relationship.targetEntityName, 160);
  const label = bounded(relationship.name || `${source} → ${target}`, 160);
  return {
    id: `relationship:${bounded(relationship.id, 460)}`,
    label,
    description: [
      `Selected ${database} schema relationship "${label}" (id ${bounded(relationship.id, 200)}).`,
      `Cardinality: ${relationship.type}.`,
      `Source: ${source}${relationship.sourceFieldName ? `.${bounded(relationship.sourceFieldName, 120)}` : ''}.`,
      `Target: ${target}${relationship.targetFieldName ? `.${bounded(relationship.targetFieldName, 120)}` : ''}.`,
      relationship.onDelete ? `On delete: ${relationship.onDelete}.` : '',
      relationship.onUpdate ? `On update: ${relationship.onUpdate}.` : '',
      relationship.implementationType ? `Implementation: ${relationship.implementationType}.` : '',
    ].filter(Boolean).join(' '),
    icon: 'conversion_path',
    groupLabel: 'schema relationships',
    data: {
      relationshipId: bounded(relationship.id, 200),
      name: relationship.name ? bounded(relationship.name, 160) : undefined,
      database,
      type: relationship.type,
      sourceEntityName: source,
      targetEntityName: target,
      sourceFieldName: relationship.sourceFieldName ? bounded(relationship.sourceFieldName, 120) : undefined,
      targetFieldName: relationship.targetFieldName ? bounded(relationship.targetFieldName, 120) : undefined,
      onDelete: relationship.onDelete,
      onUpdate: relationship.onUpdate,
      implementationType: relationship.implementationType,
    },
    includeData: true,
  };
}
