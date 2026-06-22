/**
 * Tests for parseTrackerYAML — focused on relationship-field key fidelity
 * (NIM-870). The on-disk schema stores the relationship-extended keys; the
 * parser must carry them into the in-memory FieldDefinition so multi-value and
 * target/vocab enforcement actually take effect.
 */

import { describe, it, expect } from 'vitest';
import { parseTrackerYAML } from '../YAMLParser';

const BASE = `
type: plan
displayName: Plan
displayNamePlural: Plans
icon: assignment
color: '#7c3aed'
modes:
  inline: true
idPrefix: PLAN
`;

describe('parseTrackerYAML — relationship fields (NIM-870)', () => {
  it('carries relationship-extended keys through into the FieldDefinition', () => {
    const model = parseTrackerYAML(`${BASE}
fields:
  - name: dependsOn
    type: relationship
    relationshipTypeKey: depends-on
    targetTrackerTypes: ['plan', 'feature', 'bug']
    multiValue: true
    inverseFieldId: blockedBy
    inverseRelationshipTypeKey: blocks
    symmetric: false
    preventsCompletion: true
    childRelationship: false
    allowSelfLink: false
    readOnly: false
`);

    const field = model.fields.find((f) => f.name === 'dependsOn');
    expect(field).toBeDefined();
    expect(field!.type).toBe('relationship');
    expect(field!.relationshipTypeKey).toBe('depends-on');
    expect(field!.targetTrackerTypes).toEqual(['plan', 'feature', 'bug']);
    expect(field!.multiValue).toBe(true);
    expect(field!.inverseFieldId).toBe('blockedBy');
    expect(field!.inverseRelationshipTypeKey).toBe('blocks');
    expect(field!.preventsCompletion).toBe(true);
  });

  it("supports targetTrackerTypes: '*' (any type)", () => {
    const model = parseTrackerYAML(`${BASE}
fields:
  - name: relatesTo
    type: relationship
    relationshipTypeKey: relates-to
    targetTrackerTypes: '*'
    multiValue: true
`);
    const field = model.fields.find((f) => f.name === 'relatesTo');
    expect(field!.targetTrackerTypes).toBe('*');
  });
});
