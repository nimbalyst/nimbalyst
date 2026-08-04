/**
 * The text-token grammar behind the tracker filter omnibox.
 *
 * Greg's ask: "I want to share the text filter we use in the other view, but I
 * want to add typeahead menus to get the full power of the filter dropdown, all
 * from the keyboard input." So this module is the translation layer between
 * what someone types and the `{ field, op, value }` clauses the rest of the
 * tracker already speaks -- the same objects the filter dropdown, saved views,
 * the CLI, and `tracker_list` build.
 *
 * Grammar (a token is one whitespace-delimited run, quotes protect spaces):
 *
 *   field:value            -- the field's default operator ("status:open")
 *   field:op:value         -- an explicit operator ("title:contains:auth")
 *   field:unary            -- an operator that takes no operand ("assignee:me")
 *   field:op:a,b           -- multi-value operators ("status:any-of:open,done")
 *
 * Everything outside a token is plain search text, so the box degrades to the
 * ordinary search input when nobody types a colon.
 *
 * Pure and I/O-free: the component owns the input, this owns the language.
 */

import {
  isClauseComplete,
  opsForFieldType,
  OP_LABELS,
  UNARY_OPS,
  type FieldType,
  type TrackerFieldFilter,
  type TrackerFilterOp,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

/**
 * The shape the omnibox needs from a filter field.
 *
 * Structurally satisfied by `TrackerFilterField`; declared locally so tests (and
 * this module) never pull a React component in just for a type.
 */
export interface FilterTokenField {
  id: string;
  label: string;
  type?: FieldType;
  multiValue?: boolean;
  options?: Array<{
    value: string;
    label: string;
    count?: number;
    color?: string;
    icon?: string;
  }>;
}

/** The canonical text spelling of each operator. */
export const OP_TOKENS: Record<TrackerFilterOp, string> = {
  '=': 'is',
  '!=': 'is-not',
  'contains': 'contains',
  'not-contains': 'not-contains',
  'in': 'any-of',
  'not-in': 'none-of',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  'between': 'between',
  'in-last': 'in-last',
  'not-in-last': 'not-in-last',
  'is-current-user': 'me',
  'is-not-current-user': 'not-me',
  'is-empty': 'empty',
  'is-not-empty': 'not-empty',
};

/** Operators that stand alone as `field:op` with no operand. */
const UNARY_OP_TOKENS = new Set(
  (Object.keys(OP_TOKENS) as TrackerFilterOp[])
    .filter(op => UNARY_OPS.has(op))
    .map(op => OP_TOKENS[op]),
);

/** Operators whose operand is a list the user builds up value by value. */
const LIST_OPS: ReadonlySet<TrackerFilterOp> = new Set<TrackerFilterOp>(['in', 'not-in', 'between']);

/** Every spelling that resolves to an operator: canonical token, raw id, symbol. */
const OP_ALIASES: Record<string, TrackerFilterOp> = (() => {
  const aliases: Record<string, TrackerFilterOp> = {};
  for (const [op, token] of Object.entries(OP_TOKENS) as Array<[TrackerFilterOp, string]>) {
    aliases[token] = op;
    // The raw operator id is always accepted too, so a clause copied out of a
    // saved view or an MCP call pastes back in verbatim.
    aliases[op] = op;
  }
  aliases['isnt'] = '!=';
  aliases['not'] = '!=';
  aliases['has'] = 'contains';
  return aliases;
})();

export function isListOp(op: TrackerFilterOp): boolean {
  return LIST_OPS.has(op);
}

/** `Status changed to` -> `status-changed-to`. */
export function slugifyFieldToken(text: string): string {
  return text
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Every spelling that resolves to this field, most readable first. */
function fieldTokenCandidates(field: FilterTokenField): string[] {
  const candidates = [slugifyFieldToken(field.label), field.id.toLowerCase(), slugifyFieldToken(field.id)];
  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * The token text to write for a field.
 *
 * Prefers the human label's slug and falls back to the id when two fields would
 * otherwise share a spelling -- a token has to round-trip to exactly one field.
 */
export function tokenKeyForField(field: FilterTokenField, fields: FilterTokenField[]): string {
  const slug = slugifyFieldToken(field.label);
  if (!slug) return field.id.toLowerCase();
  const collides = fields.some(
    candidate => candidate.id !== field.id && slugifyFieldToken(candidate.label) === slug,
  );
  return collides ? field.id.toLowerCase() : slug;
}

/** Resolve a typed field token to a field. Exact spellings only. */
export function resolveFieldToken(
  token: string,
  fields: FilterTokenField[],
): FilterTokenField | undefined {
  const normalized = slugifyFieldToken(token);
  if (!normalized) return undefined;
  return fields.find(field => fieldTokenCandidates(field).includes(normalized));
}

/** Fields worth offering for a partially typed field token, best match first. */
export function suggestFields(query: string, fields: FilterTokenField[]): FilterTokenField[] {
  const normalized = slugifyFieldToken(query);
  if (!normalized) return fields;
  const prefix: FilterTokenField[] = [];
  const substring: FilterTokenField[] = [];
  for (const field of fields) {
    const candidates = fieldTokenCandidates(field);
    if (candidates.some(candidate => candidate.startsWith(normalized))) prefix.push(field);
    else if (candidates.some(candidate => candidate.includes(normalized))) substring.push(field);
  }
  return [...prefix, ...substring];
}

/** Resolve a typed operator token, restricted to the operators the field allows. */
export function resolveOpToken(
  token: string,
  field: FilterTokenField | undefined,
): TrackerFilterOp | undefined {
  const op = OP_ALIASES[token.trim().toLowerCase()];
  if (!op) return undefined;
  if (field && !opsForFieldType(field.type).includes(op)) return undefined;
  return op;
}

/**
 * The operator a bare `field:value` token means.
 *
 * Text fields default to `contains` because that is what typing a fragment into
 * a search box implies; everything else defaults to equality.
 */
export function defaultOpForField(field: FilterTokenField | undefined): TrackerFilterOp {
  switch (field?.type) {
    case 'multiselect':
    case 'array':
    case 'relationship':
    case 'reference':
      return 'contains';
    case 'select':
    case 'user':
    case 'boolean':
    case 'number':
    case 'date':
    case 'datetime':
      return '=';
    default:
      return 'contains';
  }
}

/**
 * Split on commas that are not inside quotes, preserving the text verbatim.
 *
 * Quoting survives the split so an accumulated list can be written straight back
 * into the input; `stripQuotes` unwraps it at the point a value is used.
 */
function splitValueList(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Loosen a partially typed quoted value so it still matches option labels. */
function unquoteForMatch(text: string): string {
  return text.trim().replace(/^["']/, '').replace(/["']$/, '');
}

function stripQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteIfNeeded(value: string): string {
  return /[\s,:]/.test(value) ? `"${value}"` : value;
}

function isNumericField(field: FilterTokenField | undefined): boolean {
  return field?.type === 'number';
}

/**
 * Build a clause from resolved parts, coercing the operand to the shape
 * `matchesClause` expects for that operator.
 *
 * Returns null when the token is still incomplete (an operator that needs an
 * operand and hasn't got one), so a half-typed token never narrows the list.
 */
export function buildClause(
  field: FilterTokenField,
  op: TrackerFilterOp,
  rawValues: string[],
): TrackerFieldFilter | null {
  if (UNARY_OPS.has(op)) return { field: field.id, op };

  const values = rawValues.map(value => stripQuotes(value)).filter(value => value !== '');
  if (values.length === 0) return null;

  if (op === 'in' || op === 'not-in') {
    return { field: field.id, op, value: values };
  }
  if (op === 'between') {
    if (values.length < 2) return null;
    const pair = values.slice(0, 2).map(value => (isNumericField(field) ? Number(value) : value));
    if (pair.some(value => typeof value === 'number' && Number.isNaN(value))) return null;
    return { field: field.id, op, value: pair };
  }
  if (op === 'in-last' || op === 'not-in-last') {
    const days = Number(values[0]);
    if (!Number.isFinite(days) || days < 0) return null;
    return { field: field.id, op, value: days };
  }
  if (isNumericField(field)) {
    const numeric = Number(values[0]);
    if (!Number.isFinite(numeric)) return null;
    return { field: field.id, op, value: numeric };
  }
  return { field: field.id, op, value: values[0] };
}

export type TokenStage = 'field' | 'tag' | 'op-or-value' | 'value';

export interface TokenDraft {
  /** The raw token text, exactly as typed. */
  raw: string;
  stage: TokenStage;
  /** Text after the `#`, when a tag is being typed. */
  tagQuery: string;
  /** Text before the first colon. */
  fieldToken: string;
  field?: FilterTokenField;
  /** Resolved operator, when the token spelled one out. */
  op?: TrackerFilterOp;
  /** Values already terminated by a comma. */
  values: string[];
  /** The trailing fragment the value menu filters on. */
  valueQuery: string;
}

export interface OmniboxParse {
  /** The plain-text part of the input; drives the shared search query. */
  searchText: string;
  /** The token being composed at the caret, if any. */
  draft: TokenDraft;
  /** Offset in the input where the draft token starts. */
  tokenStart: number;
}

/** Index where the last whitespace-delimited (quote-aware) token begins. */
function lastTokenStart(text: string): number {
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') start = index + 1;
  }
  return start;
}

/**
 * Split the input into its search text and the token under composition.
 *
 * A trailing word only becomes a *token* once it contains a colon. Before that
 * it stays part of the search text (so typing "sta" really does search for
 * "sta") while still offering `Status` in the menu -- the field suggestion is an
 * offer, not a seizure of what was typed.
 */
export function parseOmniboxInput(text: string, fields: FilterTokenField[]): OmniboxParse {
  const tokenStart = lastTokenStart(text);
  const trailing = text.slice(tokenStart);

  // `#` keeps the meaning it has always had in the tracker search box: the rest
  // of the word is a tag being completed, and it belongs to the token rather
  // than to the search text.
  if (trailing.startsWith('#')) {
    return {
      searchText: text.slice(0, tokenStart),
      tokenStart,
      draft: {
        raw: trailing,
        stage: 'tag',
        tagQuery: trailing.slice(1),
        fieldToken: '',
        values: [],
        valueQuery: '',
      },
    };
  }

  const colonIndex = trailing.indexOf(':');

  if (colonIndex < 0) {
    return {
      searchText: text,
      tokenStart,
      draft: {
        raw: trailing,
        stage: 'field',
        tagQuery: '',
        fieldToken: trailing,
        values: [],
        valueQuery: '',
      },
    };
  }

  const searchText = text.slice(0, tokenStart);
  const fieldToken = trailing.slice(0, colonIndex);
  const field = resolveFieldToken(fieldToken, fields);
  const rest = trailing.slice(colonIndex + 1);

  // A quoted operand may legitimately contain a colon, so only look for an
  // operator segment when the operand did not open with a quote.
  const opSeparator = rest.startsWith('"') || rest.startsWith("'") ? -1 : rest.indexOf(':');
  const opToken = opSeparator >= 0 ? rest.slice(0, opSeparator) : '';
  const op = opSeparator >= 0 ? resolveOpToken(opToken, field) : undefined;
  const valuePart = op ? rest.slice(opSeparator + 1) : rest;

  const parts = splitValueList(valuePart);
  const valueQuery = parts.at(-1) ?? '';
  const values = parts.slice(0, -1);

  return {
    searchText,
    tokenStart,
    draft: {
      raw: trailing,
      stage: op ? 'value' : 'op-or-value',
      tagQuery: '',
      fieldToken,
      field,
      op,
      values,
      valueQuery,
    },
  };
}

/** The operator a draft resolves to, including the `field:me` unary shorthand. */
export function resolveDraftOp(draft: TokenDraft): TrackerFilterOp | undefined {
  if (draft.op) return draft.op;
  if (!draft.field) return undefined;
  if (draft.values.length === 0 && UNARY_OP_TOKENS.has(draft.valueQuery.trim().toLowerCase())) {
    return resolveOpToken(draft.valueQuery, draft.field);
  }
  return defaultOpForField(draft.field);
}

/** The clause a draft would commit to right now, or null if it isn't complete. */
export function draftToClause(draft: TokenDraft): TrackerFieldFilter | null {
  if (!draft.field) return null;
  const op = resolveDraftOp(draft);
  if (!op) return null;
  const clause = buildClause(draft.field, op, [...draft.values, draft.valueQuery]);
  return clause && isClauseComplete(clause) ? clause : null;
}

/** Parse a whole token in one go (`status:any-of:open,done`). */
export function parseFilterToken(
  token: string,
  fields: FilterTokenField[],
): TrackerFieldFilter | null {
  return draftToClause(parseOmniboxInput(token, fields).draft);
}

/** Write a clause back out as a token, using the shortest spelling that parses. */
export function serializeClause(
  clause: TrackerFieldFilter,
  fields: FilterTokenField[],
): string {
  const field = fields.find(candidate => candidate.id === clause.field);
  const key = field ? tokenKeyForField(field, fields) : slugifyFieldToken(clause.field);
  const opToken = OP_TOKENS[clause.op];
  if (UNARY_OPS.has(clause.op)) return `${key}:${opToken}`;

  const values = (Array.isArray(clause.value) ? clause.value : [clause.value])
    .map(value => quoteIfNeeded(String(value ?? '')))
    .join(',');
  // The default operator is implied, so `status:open` round-trips rather than
  // reading back as the noisier `status:is:open`.
  return field && clause.op === defaultOpForField(field) && !isListOp(clause.op)
    ? `${key}:${values}`
    : `${key}:${opToken}:${values}`;
}

export type TokenSuggestionKind = 'field' | 'tag' | 'op' | 'value' | 'free-text' | 'apply';

export interface TokenSuggestion {
  id: string;
  label: string;
  /** Secondary text (option counts, operator explanations). */
  detail?: string;
  section: string;
  kind: TokenSuggestionKind;
  /** Token text that replaces the draft; the menu stays open. */
  insertText?: string;
  /** Clause to commit; the token leaves the input as a pill. */
  clause?: TrackerFieldFilter;
  /** Tag to add to the tag filter; the token leaves the input as a chip. */
  tag?: string;
}

export interface TagTokenOption {
  name: string;
  count: number;
}

export interface BuildSuggestionsOptions {
  /** Max suggestions per section. Default 8. */
  limit?: number;
  /** Tags available for `#` completion, active ones already removed. */
  tagOptions?: TagTokenOption[];
}

function matchesQuery(query: string, ...haystack: string[]): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return haystack.some(value => value.toLowerCase().includes(normalized));
}

function valueSuggestions(
  draft: TokenDraft,
  field: FilterTokenField,
  op: TrackerFilterOp,
  key: string,
  limit: number,
): TokenSuggestion[] {
  const options = field.type === 'boolean' && !field.options?.length
    ? [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]
    : field.options ?? [];
  const accumulating = isListOp(op);
  const prefix = op === defaultOpForField(field) && !accumulating
    ? `${key}:`
    : `${key}:${OP_TOKENS[op]}:`;
  const chosen = new Set(draft.values.map(value => stripQuotes(value)));

  return options
    .filter(option => !chosen.has(option.value))
    .filter(option => matchesQuery(unquoteForMatch(draft.valueQuery), option.label, option.value))
    .slice(0, limit)
    .map(option => {
      const detail = option.count === undefined
        ? undefined
        : `${option.count} item${option.count === 1 ? '' : 's'}`;
      if (accumulating) {
        const list = [...draft.values, quoteIfNeeded(option.value)].join(',');
        return {
          id: `value:${option.value}`,
          label: option.label,
          detail,
          section: 'Values',
          kind: 'value' as const,
          insertText: `${prefix}${list},`,
        };
      }
      return {
        id: `value:${option.value}`,
        label: option.label,
        detail,
        section: 'Values',
        kind: 'value' as const,
        clause: buildClause(field, op, [option.value]) ?? undefined,
      };
    })
    .filter(suggestion => suggestion.kind !== 'value' || suggestion.insertText || suggestion.clause);
}

function opSuggestions(
  draft: TokenDraft,
  field: FilterTokenField,
  key: string,
  query: string,
  limit: number,
): TokenSuggestion[] {
  return opsForFieldType(field.type)
    .filter(op => matchesQuery(query, OP_TOKENS[op], OP_LABELS[op]))
    .slice(0, limit)
    .map(op => (UNARY_OPS.has(op)
      ? {
          id: `op:${op}`,
          label: `${field.label} ${OP_LABELS[op]}`,
          detail: `${key}:${OP_TOKENS[op]}`,
          section: 'Operators',
          kind: 'op' as const,
          clause: { field: field.id, op },
        }
      : {
          id: `op:${op}`,
          label: OP_LABELS[op],
          detail: `${key}:${OP_TOKENS[op]}:…`,
          section: 'Operators',
          kind: 'op' as const,
          insertText: `${key}:${OP_TOKENS[op]}:`,
        }));
}

/**
 * The menu for the current draft.
 *
 * Ordering is deliberate: values first (the common case), operators after, so
 * `status:` + Enter lands on a status rather than on "is not".
 */
export function buildTokenSuggestions(
  draft: TokenDraft,
  fields: FilterTokenField[],
  { limit = 8, tagOptions = [] }: BuildSuggestionsOptions = {},
): TokenSuggestion[] {
  if (draft.stage === 'tag') {
    const query = draft.tagQuery.trim().toLowerCase();
    return tagOptions
      .filter(option => !query || option.name.toLowerCase().includes(query))
      .slice(0, limit)
      .map(option => ({
        id: `tag:${option.name}`,
        label: `#${option.name}`,
        detail: String(option.count),
        section: 'Tags',
        kind: 'tag' as const,
        tag: option.name,
      }));
  }

  if (draft.stage === 'field' || !draft.field) {
    return suggestFields(draft.fieldToken, fields)
      .slice(0, limit)
      .map(field => ({
        id: `field:${field.id}`,
        label: field.label,
        detail: `${tokenKeyForField(field, fields)}:`,
        section: 'Filter by field',
        kind: 'field' as const,
        insertText: `${tokenKeyForField(field, fields)}:`,
      }));
  }

  const field = draft.field;
  const key = tokenKeyForField(field, fields);
  const suggestions: TokenSuggestion[] = [];

  if (draft.stage === 'value' && draft.op) {
    const op = draft.op;
    if (isListOp(op)) {
      const pending = [...draft.values, draft.valueQuery];
      const clause = buildClause(field, op, pending);
      if (clause && isClauseComplete(clause)) {
        const count = (clause.value as unknown[]).length;
        suggestions.push({
          id: 'apply',
          label: `Apply ${count} value${count === 1 ? '' : 's'}`,
          detail: OP_LABELS[op],
          section: 'Apply',
          kind: 'apply',
          clause,
        });
      }
    }
    suggestions.push(...valueSuggestions(draft, field, op, key, limit));
    const freeText = draft.valueQuery.trim();
    if (freeText && !suggestions.some(item => item.kind === 'value')) {
      const clause = buildClause(field, op, [...draft.values, freeText]);
      if (clause) {
        suggestions.push({
          id: 'free-text',
          label: `${field.label} ${OP_LABELS[op]} "${stripQuotes(freeText)}"`,
          section: 'Apply',
          kind: 'free-text',
          clause,
        });
      }
    }
    return suggestions;
  }

  // `op-or-value`: both halves of the language are one keystroke away.
  const defaultOp = defaultOpForField(field);
  const exactClause = draftToClause(draft);
  const exactUnarySuggestion = exactClause && UNARY_OPS.has(exactClause.op)
    ? opSuggestions(draft, field, key, draft.valueQuery, limit)
        .find((suggestion) => suggestion.clause?.op === exactClause.op)
    : undefined;
  // An exact unary spelling is a complete token, not free text. Keep ordinary
  // value completion first for partial input (`status:`), but make `owner:me`
  // and `title:empty` commit their grammar meaning on the default Enter path.
  if (exactUnarySuggestion) suggestions.push(exactUnarySuggestion);
  suggestions.push(...valueSuggestions(draft, field, defaultOp, key, limit));

  const freeText = draft.valueQuery.trim();
  if (freeText && !suggestions.some(item => item.kind === 'value')) {
    const clause = buildClause(field, defaultOp, [freeText]);
    if (clause) {
      suggestions.push({
        id: 'free-text',
        label: `${field.label} ${OP_LABELS[defaultOp]} "${stripQuotes(freeText)}"`,
        section: 'Apply',
        kind: 'free-text',
        clause,
      });
    }
  }

  suggestions.push(
    ...opSuggestions(draft, field, key, draft.valueQuery, limit)
      .filter((suggestion) => suggestion.id !== exactUnarySuggestion?.id),
  );
  return suggestions;
}
