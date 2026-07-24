/**
 * Export Service for DatamodelLM
 *
 * Exports data models to various formats:
 * - SQL DDL (PostgreSQL, MySQL, SQLite)
 * - JSON Schema
 * - DBML
 * - Mongoose Schema (for MongoDB)
 * - MongoDB Index Scripts
 * - JSON (internal format)
 */

import type { Entity, Relationship, Database } from './types';

export type ExportFormat =
  | 'sql'
  | 'json-schema'
  | 'dbml'
  | 'mongoose'
  | 'mongodb-indexes'
  | 'json';

export interface ExportOptions {
  database: Database;
  format: ExportFormat;
  entities: Entity[];
  relationships: Relationship[];
}

/**
 * Export schema to the specified format
 */
export function exportSchema(options: ExportOptions): string {
  const { database, format, entities, relationships } = options;

  switch (format) {
    case 'sql':
      return exportSQL(database, entities, relationships);
    case 'json-schema':
      return exportJSONSchema(entities);
    case 'dbml':
      return exportDBML(entities, relationships);
    case 'mongoose':
      return exportMongoose(entities, relationships);
    case 'mongodb-indexes':
      return exportMongoDBIndexes(entities);
    case 'json':
      return exportJSON(entities, relationships);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

/**
 * Export to SQL DDL format
 */
function exportSQL(database: Database, entities: Entity[], relationships: Relationship[]): string {
  const lines: string[] = [];

  lines.push(`-- Generated SQL DDL for ${database.toUpperCase()}`);
  lines.push(`-- Generated at ${new Date().toISOString()}`);
  lines.push('');

  // Create tables
  for (const entity of entities) {
    if (entity.description) {
      lines.push(`-- ${entity.description}`);
    }
    lines.push(`CREATE TABLE ${entity.name} (`);

    const fieldLines: string[] = [];
    for (const field of entity.fields) {
      let fieldDef = `  ${field.name} ${mapDataTypeToSQL(field.dataType, database)}`;

      if (field.isPrimaryKey) {
        fieldDef += ' PRIMARY KEY';
        if (database === 'mysql') {
          fieldDef += ' AUTO_INCREMENT';
        }
      }

      if (!field.isNullable && !field.isPrimaryKey) {
        fieldDef += ' NOT NULL';
      }

      if (field.defaultValue) {
        fieldDef += ` DEFAULT ${field.defaultValue}`;
      }

      if (field.description) {
        fieldDef += ` -- ${field.description}`;
      }

      fieldLines.push(fieldDef);
    }

    lines.push(fieldLines.join(',\n'));
    lines.push(');');
    lines.push('');
  }

  // Add foreign key constraints
  for (const rel of relationships) {
    const sourceEntity = entities.find((e) => e.name === rel.sourceEntityName);
    const targetEntity = entities.find((e) => e.name === rel.targetEntityName);

    if (!sourceEntity || !targetEntity) continue;

    // For 1:N and N:M relationships, add foreign key
    if (rel.type === '1:N' || rel.type === 'N:M') {
      const fkField = rel.targetFieldName || `${sourceEntity.name.toLowerCase()}_id`;
      const pkField = rel.sourceFieldName || 'id';

      if (fkField && pkField) {
        lines.push(`ALTER TABLE ${targetEntity.name}`);
        lines.push(`  ADD CONSTRAINT fk_${targetEntity.name}_${sourceEntity.name}`);
        lines.push(`  FOREIGN KEY (${fkField}) REFERENCES ${sourceEntity.name}(${pkField})`);

        if (rel.onDelete) {
          lines.push(`  ON DELETE ${rel.onDelete}`);
        }
        if (rel.onUpdate) {
          lines.push(`  ON UPDATE ${rel.onUpdate}`);
        }

        lines.push(';');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Map internal data types to SQL types
 */
function mapDataTypeToSQL(dataType: string, database: Database): string {
  const typeMap: Record<string, Record<Database, string>> = {
    string: {
      postgres: 'VARCHAR(255)',
      mysql: 'VARCHAR(255)',
      sqlite: 'TEXT',
      mongodb: 'VARCHAR(255)',
      couchdb: 'VARCHAR(255)',
    },
    integer: {
      postgres: 'INTEGER',
      mysql: 'INT',
      sqlite: 'INTEGER',
      mongodb: 'INTEGER',
      couchdb: 'INTEGER',
    },
    bigint: {
      postgres: 'BIGINT',
      mysql: 'BIGINT',
      sqlite: 'INTEGER',
      mongodb: 'BIGINT',
      couchdb: 'BIGINT',
    },
    float: {
      postgres: 'REAL',
      mysql: 'FLOAT',
      sqlite: 'REAL',
      mongodb: 'FLOAT',
      couchdb: 'FLOAT',
    },
    decimal: {
      postgres: 'DECIMAL(10,2)',
      mysql: 'DECIMAL(10,2)',
      sqlite: 'REAL',
      mongodb: 'DECIMAL(10,2)',
      couchdb: 'DECIMAL(10,2)',
    },
    boolean: {
      postgres: 'BOOLEAN',
      mysql: 'TINYINT(1)',
      sqlite: 'INTEGER',
      mongodb: 'BOOLEAN',
      couchdb: 'BOOLEAN',
    },
    timestamp: {
      postgres: 'TIMESTAMP',
      mysql: 'DATETIME',
      sqlite: 'TEXT',
      mongodb: 'TIMESTAMP',
      couchdb: 'TIMESTAMP',
    },
    json: {
      postgres: 'JSONB',
      mysql: 'JSON',
      sqlite: 'TEXT',
      mongodb: 'JSON',
      couchdb: 'JSON',
    },
    uuid: {
      postgres: 'UUID',
      mysql: 'CHAR(36)',
      sqlite: 'TEXT',
      mongodb: 'UUID',
      couchdb: 'UUID',
    },
    text: {
      postgres: 'TEXT',
      mysql: 'TEXT',
      sqlite: 'TEXT',
      mongodb: 'TEXT',
      couchdb: 'TEXT',
    },
  };

  const normalizedType = dataType.toLowerCase();
  if (typeMap[normalizedType]) {
    return typeMap[normalizedType][database];
  }

  // Return as-is if not found
  return dataType.toUpperCase();
}

/**
 * Export to JSON Schema format
 */
function exportJSONSchema(entities: Entity[]): string {
  const schemas: Record<string, object> = {};

  for (const entity of entities) {
    const properties: Record<string, object> = {};
    const required: string[] = [];

    for (const field of entity.fields) {
      const prop: Record<string, unknown> = {};

      // Map data types to JSON Schema types
      if (
        field.dataType.includes('INT') ||
        field.dataType.includes('DECIMAL') ||
        field.dataType.includes('FLOAT') ||
        field.dataType === 'Number' ||
        field.dataType === 'integer' ||
        field.dataType === 'float' ||
        field.dataType === 'decimal' ||
        field.dataType === 'bigint'
      ) {
        prop.type = 'number';
      } else if (
        field.dataType.includes('BOOL') ||
        field.dataType === 'Boolean' ||
        field.dataType === 'boolean'
      ) {
        prop.type = 'boolean';
      } else if (field.dataType === 'Array' || field.isArray) {
        prop.type = 'array';
      } else if (field.dataType === 'Embedded' || field.isEmbedded) {
        prop.type = 'object';
      } else {
        prop.type = 'string';
      }

      if (field.description) {
        prop.description = field.description;
      }

      if (field.isArray) {
        properties[field.name] = {
          type: 'array',
          items: prop,
        };
      } else {
        properties[field.name] = prop;
      }

      if (!field.isNullable && !field.isPrimaryKey) {
        required.push(field.name);
      }
    }

    schemas[entity.name] = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(entity.description ? { description: entity.description } : {}),
    };
  }

  return JSON.stringify(schemas, null, 2);
}

/**
 * Export to DBML format
 */
function exportDBML(entities: Entity[], relationships: Relationship[]): string {
  const lines: string[] = [];

  lines.push('// Generated DBML');
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push('');

  // Tables
  for (const entity of entities) {
    if (entity.description) {
      lines.push(`// ${entity.description}`);
    }
    lines.push(`Table ${entity.name} {`);

    for (const field of entity.fields) {
      let fieldDef = `  ${field.name} ${field.dataType}`;

      const attrs: string[] = [];
      if (field.isPrimaryKey) attrs.push('pk');
      if (!field.isNullable) attrs.push('not null');
      if (field.defaultValue) attrs.push(`default: ${field.defaultValue}`);
      if (field.description) attrs.push(`note: '${field.description}'`);

      if (attrs.length > 0) {
        fieldDef += ` [${attrs.join(', ')}]`;
      }

      lines.push(fieldDef);
    }

    lines.push('}');
    lines.push('');
  }

  // Relationships
  for (const rel of relationships) {
    const sourceEntity = entities.find((e) => e.name === rel.sourceEntityName);
    const targetEntity = entities.find((e) => e.name === rel.targetEntityName);

    if (!sourceEntity || !targetEntity) continue;

    const refType = rel.type === '1:1' ? '-' : rel.type === '1:N' ? '<' : '<>';
    const sourceField = rel.sourceFieldName || 'id';
    const targetField = rel.targetFieldName || `${sourceEntity.name.toLowerCase()}_id`;
    lines.push(`Ref: ${sourceEntity.name}.${sourceField} ${refType} ${targetEntity.name}.${targetField}`);
  }

  return lines.join('\n');
}

/**
 * Export to Mongoose schema format
 */
function exportMongoose(entities: Entity[], _relationships: Relationship[]): string {
  const lines: string[] = [];

  lines.push("import mongoose from 'mongoose';");
  lines.push('');

  for (const entity of entities) {
    lines.push(`// ${entity.name} Schema`);
    if (entity.description) {
      lines.push(`// ${entity.description}`);
    }
    lines.push(`const ${entity.name}Schema = new mongoose.Schema({`);

    const fieldLines: string[] = [];
    for (const field of entity.fields) {
      if (field.name === '_id') continue; // Skip _id, automatically added by Mongoose

      let fieldDef = `  ${field.name}: `;

      // Build field definition
      const fieldOptions: string[] = [];

      // Type
      let mongooseType = 'String';
      if (field.dataType === 'Number' || field.dataType.includes('INT') || field.dataType === 'integer') {
        mongooseType = 'Number';
      } else if (field.dataType === 'Boolean' || field.dataType === 'boolean') {
        mongooseType = 'Boolean';
      } else if (field.dataType === 'Date' || field.dataType === 'timestamp') {
        mongooseType = 'Date';
      } else if (field.dataType === 'ObjectId') {
        mongooseType = 'Schema.Types.ObjectId';
      } else if (field.dataType === 'Mixed' || field.dataType === 'json') {
        mongooseType = 'Schema.Types.Mixed';
      }

      if (field.isReference && field.referenceCollection) {
        fieldOptions.push(`type: Schema.Types.ObjectId`);
        fieldOptions.push(`ref: '${field.referenceCollection}'`);
      } else if (field.isArray) {
        fieldDef += `[{ type: ${mongooseType} }]`;
      } else {
        fieldOptions.push(`type: ${mongooseType}`);
      }

      if (!field.isNullable && !field.isArray && !field.isReference) {
        fieldOptions.push('required: true');
      }

      if (field.defaultValue) {
        fieldOptions.push(`default: ${field.defaultValue}`);
      }

      if (fieldOptions.length > 0 && !field.isArray) {
        fieldDef += `{ ${fieldOptions.join(', ')} }`;
      }

      fieldLines.push(fieldDef);
    }

    lines.push(fieldLines.join(',\n'));
    lines.push('});');
    lines.push('');

    // Add indexes
    if (entity.indexes && entity.indexes.length > 0) {
      for (const index of entity.indexes) {
        const indexFields = index.fields
          .map((f) => {
            const field = entity.fields.find((ef) => ef.id === f.fieldId);
            return field ? `${field.name}: ${f.direction || 1}` : null;
          })
          .filter(Boolean)
          .join(', ');

        const indexOptions: string[] = [];
        if (index.unique) indexOptions.push('unique: true');
        if (index.sparse) indexOptions.push('sparse: true');

        const optionsStr = indexOptions.length > 0 ? `, { ${indexOptions.join(', ')} }` : '';
        lines.push(`${entity.name}Schema.index({ ${indexFields} }${optionsStr});`);
      }
      lines.push('');
    }

    lines.push(`export const ${entity.name} = mongoose.model('${entity.name}', ${entity.name}Schema);`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export MongoDB index creation scripts
 */
function exportMongoDBIndexes(entities: Entity[]): string {
  const lines: string[] = [];

  lines.push('// MongoDB Index Creation Scripts');
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push('');

  for (const entity of entities) {
    if (!entity.indexes || entity.indexes.length === 0) continue;

    lines.push(`// Indexes for ${entity.name}`);

    for (const index of entity.indexes) {
      const indexFields: Record<string, number> = {};
      for (const f of index.fields) {
        const field = entity.fields.find((ef) => ef.id === f.fieldId);
        if (field) {
          indexFields[field.name] = f.direction || 1;
        }
      }

      const options: string[] = [];
      if (index.unique) options.push('unique: true');
      if (index.sparse) options.push('sparse: true');
      if (index.ttl) options.push(`expireAfterSeconds: ${index.ttl}`);

      const optionsStr = options.length > 0 ? `, { ${options.join(', ')} }` : '';

      lines.push(`db.${entity.name}.createIndex(${JSON.stringify(indexFields)}${optionsStr});`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export to JSON (internal format)
 */
function exportJSON(entities: Entity[], relationships: Relationship[]): string {
  const data = {
    entities,
    relationships,
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Get available export formats based on database type
 */
export function getAvailableFormats(database: Database): { value: ExportFormat; label: string }[] {
  const isNoSQL = database === 'mongodb' || database === 'couchdb';

  if (isNoSQL) {
    return [
      { value: 'json-schema', label: 'JSON Schema' },
      { value: 'mongoose', label: 'Mongoose Schema' },
      { value: 'mongodb-indexes', label: 'MongoDB Index Scripts' },
      { value: 'json', label: 'JSON (DataModelLM)' },
    ];
  }

  return [
    { value: 'sql', label: `SQL DDL (${database})` },
    { value: 'json-schema', label: 'JSON Schema' },
    { value: 'dbml', label: 'DBML' },
    { value: 'json', label: 'JSON (DataModelLM)' },
  ];
}
