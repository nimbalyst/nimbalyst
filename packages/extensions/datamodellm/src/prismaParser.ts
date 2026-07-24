/**
 * Prisma Schema Parser/Serializer for DatamodelLM
 *
 * Converts between Prisma schema format (.prisma) and internal DataModelFile format.
 * Supports SQL databases (PostgreSQL, MySQL, SQLite) and MongoDB.
 *
 * Nimbalyst metadata (positions, viewport) is stored in a comment:
 * // @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{"User":{"x":100,"y":100}}}
 */

import { nanoid } from 'nanoid';
import type {
  DataModelFile,
  Entity,
  Field,
  Relationship,
  Database,
  CascadeAction,
  RelationshipType,
  EntityViewMode,
} from './types';

// ============================================================================
// Types for Prisma parsing
// ============================================================================

interface NimbalystMetadata {
  viewport: { x: number; y: number; zoom: number };
  positions: Record<string, { x: number; y: number }>;
  entityViewMode?: EntityViewMode;
}

interface ParsedPrismaModel {
  name: string;
  fields: ParsedPrismaField[];
  attributes: string[]; // @@index, @@unique, etc.
  description?: string; // From /// comments before model
}

interface ParsedPrismaField {
  name: string;
  type: string;
  isOptional: boolean;
  isArray: boolean;
  attributes: string[]; // @id, @unique, @default, @relation, etc.
  description?: string; // From /// comments before field or inline // comment
}

interface ParsedPrismaType {
  name: string;
  fields: ParsedPrismaField[];
}

// Note: Enum type kept for future enum support
// interface ParsedPrismaEnum {
//   name: string;
//   values: string[];
// }

interface ParsedDatasource {
  provider: string;
}

// ============================================================================
// Prisma Parser
// ============================================================================

/**
 * Parse a Prisma schema file into DataModelFile format
 */
export function parsePrismaSchema(content: string): DataModelFile {
  const lines = content.split('\n');

  // Extract Nimbalyst metadata from comment
  const metadata = extractNimbalystMetadata(content);

  // Parse datasource to determine database type
  const datasource = parseDatasource(content);
  const database = mapProviderToDatabase(datasource?.provider);

  // Parse all models
  const models = parseModels(lines);

  // Parse embedded types (for MongoDB)
  const types = parseTypes(lines);

  // Parse enums (for reference, not fully supported yet)
  // Note: parseEnums(lines) is available but not currently used

  // Convert to internal format
  const entities = convertModelsToEntities(models, types, metadata.positions);
  const relationships = extractRelationships(models, entities);

  return {
    version: 1,
    database,
    entities,
    relationships,
    viewport: metadata.viewport,
    entityViewMode: metadata.entityViewMode || 'standard',
  };
}

/**
 * Extract Nimbalyst metadata from // @nimbalyst comment
 */
function extractNimbalystMetadata(content: string): NimbalystMetadata {
  const defaultMetadata: NimbalystMetadata = {
    viewport: { x: 0, y: 0, zoom: 1 },
    positions: {},
  };

  const match = content.match(/\/\/\s*@nimbalyst\s+({.+})/);
  if (!match) return defaultMetadata;

  try {
    const parsed = JSON.parse(match[1]);
    return {
      viewport: parsed.viewport || defaultMetadata.viewport,
      positions: parsed.positions || {},
      entityViewMode: parsed.entityViewMode,
    };
  } catch {
    console.warn('[DatamodelLM] Failed to parse @nimbalyst metadata');
    return defaultMetadata;
  }
}

/**
 * Parse datasource block
 */
function parseDatasource(content: string): ParsedDatasource | null {
  const match = content.match(/datasource\s+\w+\s*\{([^}]+)\}/);
  if (!match) return null;

  const providerMatch = match[1].match(/provider\s*=\s*"(\w+)"/);
  return providerMatch ? { provider: providerMatch[1] } : null;
}

/**
 * Map Prisma provider to internal Database type
 */
function mapProviderToDatabase(provider?: string): Database {
  switch (provider) {
    case 'postgresql':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
      return 'mongodb';
    case 'cockroachdb':
      return 'postgres'; // CockroachDB is PostgreSQL-compatible
    default:
      return 'postgres';
  }
}

/**
 * Parse model blocks from Prisma schema
 */
function parseModels(lines: string[]): ParsedPrismaModel[] {
  const models: ParsedPrismaModel[] = [];
  let currentModel: ParsedPrismaModel | null = null;
  let braceDepth = 0;
  let pendingDescription: string[] = []; // Collect /// comments

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines (but reset pending description)
    if (trimmed === '') {
      // Don't reset pendingDescription here - allow multiple /// comments
      continue;
    }

    // Collect /// documentation comments
    if (trimmed.startsWith('///')) {
      const docText = trimmed.slice(3).trim();
      pendingDescription.push(docText);
      continue;
    }

    // Skip other comments (but reset pending description)
    if (trimmed.startsWith('//')) {
      // Don't skip @nimbalyst comments, but don't reset description either
      if (!trimmed.includes('@nimbalyst')) {
        pendingDescription = [];
      }
      continue;
    }

    // Start of model
    const modelMatch = trimmed.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      currentModel = {
        name: modelMatch[1],
        fields: [],
        attributes: [],
        description: pendingDescription.length > 0 ? pendingDescription.join(' ') : undefined,
      };
      braceDepth = 1;
      pendingDescription = [];
      continue;
    }

    // Reset description if we're not at a model
    if (!currentModel) {
      pendingDescription = [];
    }

    if (currentModel) {
      // Track brace depth
      braceDepth += (trimmed.match(/\{/g) || []).length;
      braceDepth -= (trimmed.match(/\}/g) || []).length;

      // End of model
      if (braceDepth === 0) {
        models.push(currentModel);
        currentModel = null;
        pendingDescription = [];
        continue;
      }

      // Model-level attribute (@@)
      if (trimmed.startsWith('@@')) {
        currentModel.attributes.push(trimmed);
        pendingDescription = [];
        continue;
      }

      // Field definition
      const field = parseFieldLine(trimmed, pendingDescription.length > 0 ? pendingDescription.join(' ') : undefined);
      if (field) {
        currentModel.fields.push(field);
      }
      pendingDescription = [];
    }
  }

  return models;
}

/**
 * Parse a single field line
 */
function parseFieldLine(line: string, pendingDescription?: string): ParsedPrismaField | null {
  // Field format: name Type? @attribute1 @attribute2 // inline comment
  // Examples:
  //   id        String   @id @default(cuid())
  //   email     String   @unique
  //   posts     Post[]
  //   author    User     @relation(fields: [authorId], references: [id])
  //   name      String   // User's display name

  // Extract inline comment as description if present
  let inlineDescription: string | undefined;
  const commentIndex = line.indexOf('//');
  let fieldPart = line;
  if (commentIndex !== -1) {
    inlineDescription = line.slice(commentIndex + 2).trim();
    fieldPart = line.slice(0, commentIndex).trim();
  }

  if (!fieldPart) return null;

  // Match field: name, type (with optional ? and []), and attributes
  const match = fieldPart.match(/^(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)/);
  if (!match) return null;

  const [, name, type, optional, array, attributesStr] = match;

  // Parse attributes
  const attributes: string[] = [];
  const attrRegex = /@\w+(?:\([^)]*\))?/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
    attributes.push(attrMatch[0]);
  }

  // Use pending description (from ///) first, then inline comment
  const description = pendingDescription || inlineDescription;

  return {
    name,
    type,
    isOptional: !!optional,
    isArray: !!array,
    attributes,
    description,
  };
}

/**
 * Parse type blocks (embedded types for MongoDB)
 */
function parseTypes(lines: string[]): ParsedPrismaType[] {
  const types: ParsedPrismaType[] = [];
  let currentType: ParsedPrismaType | null = null;
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed === '') continue;

    // Start of type
    const typeMatch = trimmed.match(/^type\s+(\w+)\s*\{/);
    if (typeMatch) {
      currentType = { name: typeMatch[1], fields: [] };
      braceDepth = 1;
      continue;
    }

    if (currentType) {
      braceDepth += (trimmed.match(/\{/g) || []).length;
      braceDepth -= (trimmed.match(/\}/g) || []).length;

      if (braceDepth === 0) {
        types.push(currentType);
        currentType = null;
        continue;
      }

      const field = parseFieldLine(trimmed);
      if (field) {
        currentType.fields.push(field);
      }
    }
  }

  return types;
}

/**
 * Convert parsed models to internal Entity format
 */
function convertModelsToEntities(
  models: ParsedPrismaModel[],
  types: ParsedPrismaType[],
  positions: Record<string, { x: number; y: number }>
): Entity[] {
  // Create a map of embedded types
  const typeMap = new Map(types.map((t) => [t.name, t]));

  return models.map((model, index) => {
    // Get position from metadata or auto-position
    const position = positions[model.name] || {
      x: 100 + (index % 4) * 350,
      y: 100 + Math.floor(index / 4) * 300,
    };

    const fields: Field[] = model.fields
      .filter((f) => !isRelationField(f, models))
      .map((f) => convertPrismaFieldToField(f, typeMap));

    return {
      id: nanoid(),
      name: model.name,
      fields,
      position,
      description: model.description,
    };
  });
}

/**
 * Check if a field is a relation field (should not be shown as a regular field)
 */
function isRelationField(field: ParsedPrismaField, models: ParsedPrismaModel[]): boolean {
  // It's a relation field if the type matches another model name
  const modelNames = new Set(models.map((m) => m.name));
  return modelNames.has(field.type);
}

/**
 * Convert Prisma field to internal Field format
 */
function convertPrismaFieldToField(
  prismaField: ParsedPrismaField,
  typeMap: Map<string, ParsedPrismaType>
): Field {
  const field: Field = {
    id: nanoid(),
    name: prismaField.name,
    dataType: mapPrismaTypeToDataType(prismaField.type),
    isNullable: prismaField.isOptional,
    isArray: prismaField.isArray,
    description: prismaField.description,
  };

  // Check for @id
  if (prismaField.attributes.some((a) => a === '@id')) {
    field.isPrimaryKey = true;
  }

  // Check for @unique
  if (prismaField.attributes.some((a) => a === '@unique')) {
    // We could add an isUnique field, but for now we just note it
  }

  // Check for @default
  const defaultMatch = prismaField.attributes.find((a) => a.startsWith('@default'));
  if (defaultMatch) {
    const valueMatch = defaultMatch.match(/@default\((.+)\)/);
    if (valueMatch) {
      field.defaultValue = valueMatch[1];
    }
  }

  // Check if it's an embedded type
  const embeddedType = typeMap.get(prismaField.type);
  if (embeddedType) {
    field.isEmbedded = true;
    field.embeddedSchema = embeddedType.fields.map((f) =>
      convertPrismaFieldToField(f, typeMap)
    );
  }

  return field;
}

/**
 * Map Prisma type to internal dataType string
 */
function mapPrismaTypeToDataType(prismaType: string): string {
  // Standard Prisma scalar types
  const typeMap: Record<string, string> = {
    String: 'string',
    Int: 'integer',
    BigInt: 'bigint',
    Float: 'float',
    Decimal: 'decimal',
    Boolean: 'boolean',
    DateTime: 'timestamp',
    Json: 'json',
    Bytes: 'bytes',
  };

  return typeMap[prismaType] || prismaType.toLowerCase();
}

/**
 * Extract relationships from parsed models
 */
function extractRelationships(
  models: ParsedPrismaModel[],
  _entities: Entity[]
): Relationship[] {
  const relationships: Relationship[] = [];
  const modelNames = new Set(models.map((m) => m.name));
  const processedPairs = new Set<string>();

  for (const model of models) {
    for (const field of model.fields) {
      // Skip if not a relation field
      if (!modelNames.has(field.type)) continue;

      // Create a unique key for this relationship pair (to avoid duplicates)
      const pairKey = [model.name, field.type].sort().join('|');
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      // Parse @relation attribute if present
      const relationAttr = field.attributes.find((a) => a.startsWith('@relation'));
      let sourceFieldName: string | undefined;
      let targetFieldName: string | undefined;
      let onDelete: CascadeAction | undefined;
      let onUpdate: CascadeAction | undefined;

      if (relationAttr) {
        const fieldsMatch = relationAttr.match(/fields:\s*\[([^\]]+)\]/);
        const referencesMatch = relationAttr.match(/references:\s*\[([^\]]+)\]/);
        const onDeleteMatch = relationAttr.match(/onDelete:\s*(\w+)/);
        const onUpdateMatch = relationAttr.match(/onUpdate:\s*(\w+)/);

        if (fieldsMatch) {
          sourceFieldName = fieldsMatch[1].trim();
        }
        if (referencesMatch) {
          targetFieldName = referencesMatch[1].trim();
        }
        if (onDeleteMatch) {
          onDelete = mapCascadeAction(onDeleteMatch[1]);
        }
        if (onUpdateMatch) {
          onUpdate = mapCascadeAction(onUpdateMatch[1]);
        }
      }

      // Determine relationship type based on array notation
      let type: RelationshipType = '1:N';
      if (field.isArray) {
        // This side is "many"
        const otherModel = models.find((m) => m.name === field.type);
        const reverseField = otherModel?.fields.find((f) => f.type === model.name);
        if (reverseField?.isArray) {
          type = 'N:M';
        }
      } else {
        const otherModel = models.find((m) => m.name === field.type);
        const reverseField = otherModel?.fields.find((f) => f.type === model.name);
        if (!reverseField?.isArray) {
          type = '1:1';
        }
      }

      relationships.push({
        id: nanoid(),
        type,
        sourceEntityName: model.name,
        targetEntityName: field.type,
        sourceFieldName,
        targetFieldName,
        onDelete,
        onUpdate,
      });
    }
  }

  return relationships;
}

/**
 * Map Prisma cascade action to internal CascadeAction
 */
function mapCascadeAction(action: string): CascadeAction {
  const actionMap: Record<string, CascadeAction> = {
    Cascade: 'CASCADE',
    SetNull: 'SET NULL',
    Restrict: 'RESTRICT',
    NoAction: 'NO ACTION',
  };
  return actionMap[action] || 'NO ACTION';
}

// ============================================================================
// Prisma Serializer
// ============================================================================

/**
 * Serialize DataModelFile to Prisma schema format
 */
export function serializeToPrismaSchema(model: DataModelFile): string {
  const lines: string[] = [];

  // Add Nimbalyst metadata comment
  const metadata: NimbalystMetadata = {
    viewport: model.viewport,
    positions: Object.fromEntries(
      model.entities.map((e) => [e.name, e.position])
    ),
    entityViewMode: model.entityViewMode,
  };
  lines.push(`// @nimbalyst ${JSON.stringify(metadata)}`);
  lines.push('');

  // Add datasource block
  lines.push('datasource db {');
  lines.push(`  provider = "${mapDatabaseToProvider(model.database)}"`);
  lines.push('  url      = env("DATABASE_URL")');
  lines.push('}');
  lines.push('');

  // Find embedded types (fields with isEmbedded)
  const embeddedTypes = new Map<string, Field[]>();
  for (const entity of model.entities) {
    for (const field of entity.fields) {
      if (field.isEmbedded && field.embeddedSchema) {
        embeddedTypes.set(field.dataType, field.embeddedSchema);
      }
    }
  }

  // Output embedded types first (for MongoDB)
  for (const [typeName, fields] of embeddedTypes) {
    lines.push(`type ${typeName} {`);
    for (const field of fields) {
      lines.push(`  ${serializeField(field)}`);
    }
    lines.push('}');
    lines.push('');
  }

  // Output models
  for (const entity of model.entities) {
    // Output entity description as /// comment
    if (entity.description) {
      lines.push(`/// ${entity.description}`);
    }
    lines.push(`model ${entity.name} {`);

    // Output fields
    for (const field of entity.fields) {
      // Output field description as /// comment
      if (field.description) {
        lines.push(`  /// ${field.description}`);
      }
      lines.push(`  ${serializeField(field)}`);
    }

    // Output relation fields
    const relatedRelationships = model.relationships.filter(
      (r) =>
        r.sourceEntityName === entity.name || r.targetEntityName === entity.name
    );

    for (const rel of relatedRelationships) {
      const isSource = rel.sourceEntityName === entity.name;
      const otherEntityName = isSource
        ? rel.targetEntityName
        : rel.sourceEntityName;

      // Only output the relation field if we haven't already (avoid duplicates)
      // The "many" side gets the array, the "one" side gets the scalar + @relation
      if (isSource && rel.sourceFieldName) {
        // This entity has the foreign key
        const relationType =
          rel.type === '1:1' ? otherEntityName : `${otherEntityName}`;
        const relationAttr = buildRelationAttribute(rel);
        lines.push(`  ${camelCase(otherEntityName)} ${relationType}${relationAttr ? ' ' + relationAttr : ''}`);
      } else if (!isSource) {
        // This entity is the target - add the reverse relation
        const isMany = rel.type === '1:N' || rel.type === 'N:M';
        const relationType = isMany ? `${rel.sourceEntityName}[]` : rel.sourceEntityName;
        lines.push(`  ${camelCase(rel.sourceEntityName)}${isMany ? 's' : ''} ${relationType}`);
      }
    }

    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Map internal Database type to Prisma provider
 */
function mapDatabaseToProvider(database: Database): string {
  switch (database) {
    case 'postgres':
      return 'postgresql';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
      return 'mongodb';
    case 'couchdb':
      return 'mongodb'; // CouchDB not supported, fallback to MongoDB
    default:
      return 'postgresql';
  }
}

/**
 * Serialize a field to Prisma format
 */
function serializeField(field: Field): string {
  let line = field.name;

  // Add padding for alignment
  line = line.padEnd(12);

  // Type
  let type = mapDataTypeToPrismaType(field.dataType);
  if (field.isEmbedded) {
    // Use the capitalized type name for embedded types
    type = capitalizeFirst(field.dataType);
  }
  if (field.isArray) {
    type += '[]';
  }
  if (field.isNullable) {
    type += '?';
  }
  line += type;

  // Attributes
  const attrs: string[] = [];
  if (field.isPrimaryKey) {
    attrs.push('@id');
  }
  if (field.defaultValue) {
    attrs.push(`@default(${field.defaultValue})`);
  }

  if (attrs.length > 0) {
    line = line.padEnd(24);
    line += attrs.join(' ');
  }

  return line;
}

/**
 * Map internal dataType to Prisma type
 */
function mapDataTypeToPrismaType(dataType: string): string {
  const typeMap: Record<string, string> = {
    string: 'String',
    integer: 'Int',
    bigint: 'BigInt',
    float: 'Float',
    decimal: 'Decimal',
    boolean: 'Boolean',
    timestamp: 'DateTime',
    json: 'Json',
    bytes: 'Bytes',
    uuid: 'String',
    text: 'String',
  };
  return typeMap[dataType] || capitalizeFirst(dataType);
}

/**
 * Build @relation attribute string
 */
function buildRelationAttribute(rel: Relationship): string {
  const parts: string[] = [];

  if (rel.sourceFieldName) {
    parts.push(`fields: [${rel.sourceFieldName}]`);
  }
  if (rel.targetFieldName) {
    parts.push(`references: [${rel.targetFieldName}]`);
  }
  if (rel.onDelete && rel.onDelete !== 'NO ACTION') {
    parts.push(`onDelete: ${mapCascadeActionToPrisma(rel.onDelete)}`);
  }
  if (rel.onUpdate && rel.onUpdate !== 'NO ACTION') {
    parts.push(`onUpdate: ${mapCascadeActionToPrisma(rel.onUpdate)}`);
  }

  return parts.length > 0 ? `@relation(${parts.join(', ')})` : '';
}

/**
 * Map internal CascadeAction to Prisma format
 */
function mapCascadeActionToPrisma(action: CascadeAction): string {
  const actionMap: Record<CascadeAction, string> = {
    CASCADE: 'Cascade',
    'SET NULL': 'SetNull',
    RESTRICT: 'Restrict',
    'NO ACTION': 'NoAction',
  };
  return actionMap[action];
}

// ============================================================================
// Utility functions
// ============================================================================

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

/**
 * Create an empty Prisma schema with Nimbalyst metadata
 */
export function createEmptyPrismaSchema(database: Database = 'postgres'): string {
  const model: DataModelFile = {
    version: 1,
    database,
    entities: [],
    relationships: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    entityViewMode: 'standard',
  };
  return serializeToPrismaSchema(model);
}
