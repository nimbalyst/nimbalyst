/**
 * Handle Utilities
 *
 * Utilities for computing which connection handles should be visible on entities
 * based on their relationships.
 */

import type { Entity, Relationship } from '../types';

export interface FieldHandleState {
  fieldId: string;
  showSourceHandle: boolean;
  showTargetHandle: boolean;
  relationshipIds: string[];
}

export interface EntityHandleState {
  [fieldId: string]: FieldHandleState;
}

/**
 * Computes which handles should be visible for each field in an entity
 * based on the relationships it participates in.
 */
export function computeHandleState(
  entity: Entity,
  _allEntities: Entity[],
  relationships: Relationship[]
): EntityHandleState {
  const handleState: EntityHandleState = {};

  // Initialize all fields with no handles visible
  entity.fields.forEach((field) => {
    handleState[field.id] = {
      fieldId: field.id,
      showSourceHandle: false,
      showTargetHandle: false,
      relationshipIds: [],
    };
  });

  // Find all relationships involving this entity
  const relevantRelationships = relationships.filter(
    (rel) =>
      rel.sourceEntityName === entity.name || rel.targetEntityName === entity.name
  );

  relevantRelationships.forEach((rel) => {
    // Determine if this entity is the source or target
    const isSource = rel.sourceEntityName === entity.name;
    const fieldName = isSource ? rel.sourceFieldName : rel.targetFieldName;

    // Skip if no field specified - this is an entity-level relationship
    if (!fieldName) return;

    // Find field by name
    const field = entity.fields.find((f) => f.name === fieldName);
    if (!field) return;

    // Set handles - position will be determined dynamically by DataModelCanvas
    if (handleState[field.id]) {
      if (isSource) {
        handleState[field.id].showSourceHandle = true;
      } else {
        handleState[field.id].showTargetHandle = true;
      }
      handleState[field.id].relationshipIds.push(rel.id);
    }
  });

  return handleState;
}
