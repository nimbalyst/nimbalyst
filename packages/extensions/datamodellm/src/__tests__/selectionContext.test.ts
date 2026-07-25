import { describe, expect, it } from 'vitest';
import { buildEntitySelectionContextItem, buildRelationshipSelectionContextItem } from '../selectionContext';
import type { Entity, Relationship } from '../types';

describe('DataModelLM selection context', () => {
  it('reports current entity fields with stable identity and bounded opt-in data', () => {
    const entity: Entity = {
      id: 'users-id',
      name: 'User',
      description: 'Application accounts',
      position: { x: 120, y: 80 },
      fields: [
        { id: 'id', name: 'id', dataType: 'uuid', isPrimaryKey: true },
        { id: 'email', name: 'email', dataType: 'varchar', isNullable: false },
      ],
      indexes: [{ id: 'email-index', name: 'users_email_key', fields: [{ fieldId: 'email' }], unique: true }],
    };
    const before = buildEntitySelectionContextItem(entity, 'postgres');
    const after = buildEntitySelectionContextItem({
      ...entity,
      fields: [...entity.fields, { id: 'display-name', name: 'displayName', dataType: 'text' }],
    }, 'postgres');

    expect(before.id).toBe('entity:users-id');
    expect(before.includeData).toBe(true);
    expect(before.groupLabel).toBe('schema entities');
    expect(before.description).toContain('email: varchar');
    expect(after.id).toBe(before.id);
    expect(after.description).toContain('displayName: text');
    expect(JSON.stringify(after.data).length).toBeLessThan(32 * 1024);
  });

  it('reports relationship endpoints and mutation freshness', () => {
    const relationship: Relationship = {
      id: 'user-posts',
      name: 'User posts',
      type: '1:N',
      sourceEntityName: 'User',
      targetEntityName: 'Post',
      sourceFieldName: 'id',
      targetFieldName: 'authorId',
      onDelete: 'CASCADE',
    };
    const before = buildRelationshipSelectionContextItem(relationship, 'postgres');
    const after = buildRelationshipSelectionContextItem({ ...relationship, onDelete: 'RESTRICT' }, 'postgres');

    expect(before.id).toBe('relationship:user-posts');
    expect(before.description).toContain('User.id');
    expect(before.description).toContain('Post.authorId');
    expect(after.id).toBe(before.id);
    expect(after.description).toContain('On delete: RESTRICT');
  });
});
