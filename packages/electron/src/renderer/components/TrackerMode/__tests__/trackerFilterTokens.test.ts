// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildTokenSuggestions,
  defaultOpForField,
  draftToClause,
  parseFilterToken,
  parseOmniboxInput,
  resolveFieldToken,
  serializeClause,
  slugifyFieldToken,
  suggestFields,
  tokenKeyForField,
  type FilterTokenField,
} from '../trackerFilterTokens';

const FIELDS: FilterTokenField[] = [
  {
    id: 'status',
    label: 'Status',
    type: 'select',
    options: [
      { value: 'open', label: 'Open', count: 3 },
      { value: 'in-progress', label: 'In Progress', count: 1 },
      { value: 'done', label: 'Done', count: 0 },
    ],
  },
  { id: 'title', label: 'Title', type: 'string' },
  { id: 'assignee', label: 'Assignee', type: 'user', options: [{ value: 'greg@x.dev', label: 'Greg' }] },
  { id: 'tags', label: 'Tags', type: 'array', multiValue: true, options: [{ value: 'ui', label: 'ui' }] },
  { id: 'points', label: 'Points', type: 'number' },
  { id: 'updated', label: 'Updated', type: 'date' },
  { id: 'statusChangedTo', label: 'Status changed to', type: 'select', options: [{ value: 'done', label: 'Done' }] },
];

const fieldOf = (id: string): FilterTokenField => FIELDS.find(field => field.id === id)!;

describe('token spellings', () => {
  it('resolves a field from its label slug, its id, and a camelCase id', () => {
    expect(resolveFieldToken('status', FIELDS)?.id).toBe('status');
    expect(resolveFieldToken('Status Changed To', FIELDS)?.id).toBe('statusChangedTo');
    expect(resolveFieldToken('status-changed-to', FIELDS)?.id).toBe('statusChangedTo');
    expect(resolveFieldToken('statuschangedto', FIELDS)?.id).toBe('statusChangedTo');
    expect(resolveFieldToken('nope', FIELDS)).toBeUndefined();
  });

  it('slugifies labels and camelCase ids the same way', () => {
    expect(slugifyFieldToken('Status changed to')).toBe('status-changed-to');
    expect(slugifyFieldToken('statusChangedTo')).toBe('status-changed-to');
  });

  it('falls back to the id when two fields share a label slug', () => {
    const colliding: FilterTokenField[] = [
      { id: 'a', label: 'Owner' },
      { id: 'ownerB', label: 'Owner' },
    ];
    expect(tokenKeyForField(colliding[0], colliding)).toBe('a');
    expect(tokenKeyForField(fieldOf('status'), FIELDS)).toBe('status');
  });

  it('ranks prefix matches above substring matches', () => {
    expect(suggestFields('stat', FIELDS).map(field => field.id))
      .toEqual(['status', 'statusChangedTo']);
    expect(suggestFields('changed', FIELDS).map(field => field.id)).toEqual(['statusChangedTo']);
  });
});

describe('parseOmniboxInput', () => {
  it('keeps a colon-free trailing word as search text while still offering fields', () => {
    const parsed = parseOmniboxInput('needs stat', FIELDS);
    expect(parsed.searchText).toBe('needs stat');
    expect(parsed.draft.stage).toBe('field');
    expect(parsed.draft.fieldToken).toBe('stat');
  });

  it('splits the search text from a token once a colon is typed', () => {
    const parsed = parseOmniboxInput('needs status:op', FIELDS);
    expect(parsed.searchText).toBe('needs ');
    expect(parsed.draft.stage).toBe('op-or-value');
    expect(parsed.draft.field?.id).toBe('status');
    expect(parsed.draft.valueQuery).toBe('op');
  });

  it('recognises an explicit operator segment', () => {
    const { draft } = parseOmniboxInput('title:contains:auth', FIELDS);
    expect(draft.stage).toBe('value');
    expect(draft.op).toBe('contains');
    expect(draft.valueQuery).toBe('auth');
  });

  it('rejects an operator the field type does not support', () => {
    // `contains` is not offered for a select field, so it reads as a value.
    const { draft } = parseOmniboxInput('status:contains:x', FIELDS);
    expect(draft.op).toBeUndefined();
    expect(draft.valueQuery).toBe('contains:x');
  });

  it('splits accumulated values on unquoted commas only', () => {
    const { draft } = parseOmniboxInput('status:any-of:open,"in, progress",do', FIELDS);
    expect(draft.op).toBe('in');
    expect(draft.values).toEqual(['open', '"in, progress"']);
    expect(draft.valueQuery).toBe('do');
  });

  it('treats a quoted operand with a colon as one value', () => {
    const { draft } = parseOmniboxInput('title:"a: b"', FIELDS);
    expect(draft.op).toBeUndefined();
    expect(draftToClause(draft)).toEqual({ field: 'title', op: 'contains', value: 'a: b' });
  });

  it('keeps a quoted value with a space in the same token', () => {
    const parsed = parseOmniboxInput('title:"needs review"', FIELDS);
    expect(parsed.searchText).toBe('');
    expect(parsed.draft.valueQuery).toBe('"needs review"');
  });
});

describe('parseFilterToken', () => {
  it('uses the field default operator for a bare value', () => {
    expect(parseFilterToken('status:open', FIELDS)).toEqual({ field: 'status', op: '=', value: 'open' });
    expect(parseFilterToken('title:auth', FIELDS)).toEqual({ field: 'title', op: 'contains', value: 'auth' });
    expect(defaultOpForField(fieldOf('tags'))).toBe('contains');
  });

  it('accepts unary operators as a bare shorthand', () => {
    expect(parseFilterToken('assignee:me', FIELDS)).toEqual({ field: 'assignee', op: 'is-current-user' });
    expect(parseFilterToken('assignee:not-me', FIELDS))
      .toEqual({ field: 'assignee', op: 'is-not-current-user' });
    expect(parseFilterToken('title:empty', FIELDS)).toEqual({ field: 'title', op: 'is-empty' });
  });

  it('accepts raw operator ids as aliases for the canonical tokens', () => {
    expect(parseFilterToken('status:=:open', FIELDS)).toEqual({ field: 'status', op: '=', value: 'open' });
    expect(parseFilterToken('status:is-not:open', FIELDS))
      .toEqual({ field: 'status', op: '!=', value: 'open' });
  });

  it('coerces list, range, numeric, and relative-date operands', () => {
    expect(parseFilterToken('status:any-of:open,done', FIELDS))
      .toEqual({ field: 'status', op: 'in', value: ['open', 'done'] });
    expect(parseFilterToken('points:between:1,10', FIELDS))
      .toEqual({ field: 'points', op: 'between', value: [1, 10] });
    expect(parseFilterToken('points:gt:3', FIELDS)).toEqual({ field: 'points', op: '>', value: 3 });
    expect(parseFilterToken('updated:in-last:7', FIELDS))
      .toEqual({ field: 'updated', op: 'in-last', value: 7 });
  });

  it('returns null while a token is still incomplete', () => {
    expect(parseFilterToken('status:', FIELDS)).toBeNull();
    expect(parseFilterToken('points:between:1', FIELDS)).toBeNull();
    expect(parseFilterToken('nosuchfield:x', FIELDS)).toBeNull();
    expect(parseFilterToken('points:gt:abc', FIELDS)).toBeNull();
  });
});

describe('serializeClause', () => {
  it('round-trips every clause shape back through the parser', () => {
    const clauses = [
      { field: 'status', op: '=' as const, value: 'open' },
      { field: 'status', op: 'in' as const, value: ['open', 'done'] },
      { field: 'title', op: 'contains' as const, value: 'needs review' },
      { field: 'assignee', op: 'is-current-user' as const },
      { field: 'points', op: 'between' as const, value: [1, 10] },
      { field: 'updated', op: 'in-last' as const, value: 7 },
      { field: 'statusChangedTo', op: '=' as const, value: 'done' },
    ];
    for (const clause of clauses) {
      expect(parseFilterToken(serializeClause(clause, FIELDS), FIELDS)).toEqual(clause);
    }
  });

  it('drops the operator segment when it is the field default', () => {
    expect(serializeClause({ field: 'status', op: '=', value: 'open' }, FIELDS)).toBe('status:open');
    expect(serializeClause({ field: 'status', op: '!=', value: 'open' }, FIELDS)).toBe('status:is-not:open');
    expect(serializeClause({ field: 'title', op: 'contains', value: 'a b' }, FIELDS)).toBe('title:"a b"');
  });
});

describe('buildTokenSuggestions', () => {
  const suggestFor = (text: string) =>
    buildTokenSuggestions(parseOmniboxInput(text, FIELDS).draft, FIELDS);

  it('offers fields while the token has no colon', () => {
    const suggestions = suggestFor('stat');
    expect(suggestions.map(item => item.kind)).toEqual(['field', 'field']);
    expect(suggestions[0].insertText).toBe('status:');
  });

  it('offers values before operators once a field is chosen', () => {
    const suggestions = suggestFor('status:');
    expect(suggestions[0]).toMatchObject({
      kind: 'value',
      label: 'Open',
      detail: '3 items',
      clause: { field: 'status', op: '=', value: 'open' },
    });
    expect(suggestions.some(item => item.kind === 'op')).toBe(true);
    expect(suggestions.findIndex(item => item.kind === 'op'))
      .toBeGreaterThan(suggestions.findIndex(item => item.kind === 'value'));
  });

  it('narrows both halves of the menu as the user keeps typing', () => {
    const values = suggestFor('status:pro');
    expect(values.filter(item => item.kind === 'value').map(item => item.label)).toEqual(['In Progress']);

    const ops = suggestFor('status:none');
    expect(ops.filter(item => item.kind === 'op').map(item => item.clause?.op ?? item.insertText))
      .toEqual(['status:none-of:']);
  });

  it('offers a free-text clause when the field has no options', () => {
    const suggestions = suggestFor('title:auth');
    expect(suggestions[0]).toMatchObject({
      kind: 'free-text',
      clause: { field: 'title', op: 'contains', value: 'auth' },
    });
  });

  it('commits unary operators straight from the operator list', () => {
    expect(suggestFor('assignee:me')[0]).toMatchObject({
      kind: 'op',
      clause: { field: 'assignee', op: 'is-current-user' },
    });
    expect(suggestFor('title:empty')[0]).toMatchObject({
      kind: 'op',
      clause: { field: 'title', op: 'is-empty' },
    });
  });

  it('accumulates list-operator values and offers an apply row', () => {
    const first = suggestFor('status:any-of:');
    expect(first[0]).toMatchObject({ kind: 'value', insertText: 'status:any-of:open,' });

    const second = suggestFor('status:any-of:open,');
    expect(second[0]).toMatchObject({
      kind: 'apply',
      clause: { field: 'status', op: 'in', value: ['open'] },
    });
    // An already-chosen value drops out of the list rather than being offered twice.
    expect(second.filter(item => item.kind === 'value').map(item => item.label))
      .not.toContain('Open');
  });

  it('falls back to field suggestions when the field token does not resolve', () => {
    expect(suggestFor('nope:x').every(item => item.kind === 'field')).toBe(true);
  });
});

describe('#tag completion', () => {
  const TAGS = [{ name: 'ui', count: 4 }, { name: 'urgent', count: 2 }, { name: 'api', count: 1 }];
  const suggestTags = (text: string) =>
    buildTokenSuggestions(parseOmniboxInput(text, FIELDS).draft, FIELDS, { tagOptions: TAGS });

  it('owns the trailing word from the `#` on, keeping the search text intact', () => {
    const parsed = parseOmniboxInput('auth #ur', FIELDS);
    expect(parsed.searchText).toBe('auth ');
    expect(parsed.draft.stage).toBe('tag');
    expect(parsed.draft.tagQuery).toBe('ur');
  });

  it('offers every tag on a bare `#` and narrows as the user types', () => {
    expect(suggestTags('#').map(item => item.tag)).toEqual(['ui', 'urgent', 'api']);
    expect(suggestTags('#u').map(item => item.tag)).toEqual(['ui', 'urgent']);
    expect(suggestTags('#zzz')).toEqual([]);
  });

  it('labels tag rows with their name and item count', () => {
    expect(suggestTags('#ui')[0]).toMatchObject({
      kind: 'tag',
      label: '#ui',
      detail: '4',
      section: 'Tags',
      tag: 'ui',
    });
  });

  it('offers no tags when the surface has none wired up', () => {
    expect(buildTokenSuggestions(parseOmniboxInput('#u', FIELDS).draft, FIELDS)).toEqual([]);
  });

  it('leaves a `#` inside a word alone', () => {
    const parsed = parseOmniboxInput('issue#12', FIELDS);
    expect(parsed.draft.stage).toBe('field');
    expect(parsed.searchText).toBe('issue#12');
  });
});
