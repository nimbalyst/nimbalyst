// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validatePredicateDefinition, type PredicateDefinition } from '../predicateRegistry';
import { relationsForPair } from '../predicateRelations';

const predicates: PredicateDefinition[] = [
  { id: 'built-on', label: 'built on', inverseLabel: 'underlies', subjectKinds: ['module'], objectKinds: ['technology'], valueShape: 'entity', direction: 'directed' },
  { id: 'competes-with', label: 'competes with', subjectKinds: ['competitor'], valueShape: 'entity', direction: 'symmetric' },
  { id: 'owned-by', label: 'owned by', inverseLabel: 'owns', subjectKinds: ['*'], valueShape: 'entity', direction: 'directed' },
  { id: 'priced-at', label: 'priced at', subjectKinds: ['*'], valueShape: 'quantity', direction: 'directed' },
];

const baseOf = (type: string) => ({ library: 'technology', service: 'module' } as Record<string, string>)[type];

describe('relationsForPair', () => {
  it('offers only entity predicates whose subject and object kinds admit the pair, through extends', () => {
    const ids = (source: string, target: string) => relationsForPair(predicates, source, target, baseOf).map(o => o.predicateId);
    expect(ids('module', 'technology')).toEqual(['built-on', 'owned-by']);
    expect(ids('service', 'library')).toEqual(['built-on', 'owned-by']);
    expect(ids('module', 'person')).toEqual(['owned-by']);
    expect(ids('competitor', 'competitor')).toEqual(['competes-with', 'owned-by']);
  });

  it('reads the inverse from the linked page, falling back to the label for symmetric and undeclared inverses', () => {
    const byId = Object.fromEntries(relationsForPair(predicates, 'competitor', 'technology', baseOf).map(o => [o.predicateId, o]));
    expect(byId['competes-with'].inverseLabel).toBe('competes with');
    expect(byId['owned-by'].inverseLabel).toBe('owns');
  });

  it('validates objectKinds like subjectKinds', () => {
    const base = { id: 'uses', label: 'uses', subjectKinds: ['*'], valueShape: 'entity', direction: 'directed' };
    expect(validatePredicateDefinition({ ...base, objectKinds: ['technology'] }).valid).toBe(true);
    expect(validatePredicateDefinition({ ...base, objectKinds: [] }).issues.map(i => i.path)).toEqual(['objectKinds']);
  });
});
