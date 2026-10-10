// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parsePredicateRegistryYAML, relationsForPair } from '@nimbalyst/tracker-schema';

// The skill's example relations are what agents copy into a project's predicate
// registry with `tracker_define_type`. They must parse with the runtime parser,
// and the link menu must offer each one for the pair of types it names, and
// not for a pair it does not.
const RELATIONS = path.resolve(__dirname, '../claude-plugin/skills/update/references/relations.yaml');
const parsed = parsePredicateRegistryYAML(readFileSync(RELATIONS, 'utf-8'));
const predicates = parsed.predicates ?? [];

describe('knowledge page relations', () => {
  it('parses cleanly and declares named relations between typed pages only', () => {
    expect(parsed.issues).toEqual([]);
    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(predicate.valueShape, predicate.id).toBe('entity');
      expect(predicate.inverseLabel, predicate.id).toBeTruthy();
      expect(predicate.objectKinds?.length, predicate.id).toBeGreaterThan(0);
      expect(predicate, predicate.id).not.toHaveProperty('qualifiers');
    }
  });

  it('offers a relation only for the types it names, subtypes included', () => {
    const ids = (source: string, target: string, baseOf?: (type: string) => string | undefined) =>
      relationsForPair(predicates, source, target, baseOf).map((option) => option.predicateId);

    expect(ids('module', 'technology')).toEqual(expect.arrayContaining(['built-on', 'implements']));
    expect(ids('technology', 'module')).toEqual([]);
    // A subtype (Libraries inside Technologies) is a technology.
    expect(ids('module', 'library', (type) => (type === 'library' ? 'technology' : undefined))).toContain('built-on');

    const builtOn = relationsForPair(predicates, 'module', 'technology').find((o) => o.predicateId === 'built-on');
    expect(builtOn?.inverseLabel).toBe('underlies');
  });
});
