/**
 * DatamodelLM Extension Types
 *
 * Core type definitions for data modeling.
 * Adapted from the standalone DatamodelLM project for use as a Nimbalyst extension.
 */

// Database types supported
export type Database =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'couchdb';

// Index definition for database tables
export interface Index {
  id: string;
  name: string;
  fields: { fieldId: string; direction?: 1 | -1 }[];
  unique?: boolean;
  sparse?: boolean;
  ttl?: number;
}

// Field definition within an entity
export interface Field {
  id: string;
  name: string;
  dataType: string;

  // SQL-specific (optional)
  isPrimaryKey?: boolean;
  isNullable?: boolean;
  isForeignKey?: boolean;
  defaultValue?: string;
  description?: string;

  // NoSQL-specific (optional)
  isArray?: boolean;
  isEmbedded?: boolean;
  embeddedSchema?: Field[];
  isReference?: boolean;
  referenceCollection?: string;
}

// Entity (table/collection) definition
export interface Entity {
  id: string;
  name: string;
  fields: Field[];
  description?: string;
  position: { x: number; y: number };
  color?: string;

  // Database-specific (optional)
  indexes?: Index[];
}

// Relationship cardinality types
export type RelationshipType = '1:1' | '1:N' | 'N:M';

// Cascade action for foreign key relationships
export type CascadeAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

// Relationship between entities
export interface Relationship {
  id: string;
  name?: string;
  type: RelationshipType;
  sourceEntityName: string;
  targetEntityName: string;
  sourceFieldName?: string;
  targetFieldName?: string;

  // SQL-specific (optional)
  onDelete?: CascadeAction;
  onUpdate?: CascadeAction;

  // NoSQL-specific (optional)
  implementationType?: 'embedded' | 'reference' | 'denormalized';
}

// Entity view modes for the canvas
export type EntityViewMode = 'full' | 'standard' | 'compact';

/**
 * DataModel file format
 *
 * This is the structure saved to .datamodel files.
 * It's a simplified version of the Project type from standalone DatamodelLM,
 * focused on the essential schema data.
 */
export interface DataModelFile {
  /** File format version */
  version: 1;

  /** Target database type */
  database: Database;

  /** Entities (tables/collections) */
  entities: Entity[];

  /** Relationships between entities */
  relationships: Relationship[];

  /** Canvas viewport state */
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };

  /** How entities are displayed */
  entityViewMode: EntityViewMode;
}

/**
 * Create a new empty data model
 */
export function createEmptyDataModel(database: Database = 'postgres'): DataModelFile {
  return {
    version: 1,
    database,
    entities: [],
    relationships: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    entityViewMode: 'standard',
  };
}

/**
 * Parse a data model file content
 */
export function parseDataModelFile(content: string): DataModelFile {
  try {
    const data = JSON.parse(content);

    // Validate version
    if (data.version !== 1) {
      console.warn('[DatamodelLM] Unknown file version:', data.version);
    }

    // Provide defaults for missing fields
    return {
      version: 1,
      database: data.database || 'postgres',
      entities: data.entities || [],
      relationships: data.relationships || [],
      viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
      entityViewMode: data.entityViewMode || 'standard',
    };
  } catch (error) {
    console.error('[DatamodelLM] Failed to parse data model file:', error);
    return createEmptyDataModel();
  }
}

/**
 * Serialize a data model to file content
 */
export function serializeDataModelFile(model: DataModelFile): string {
  return JSON.stringify(model, null, 2);
}
