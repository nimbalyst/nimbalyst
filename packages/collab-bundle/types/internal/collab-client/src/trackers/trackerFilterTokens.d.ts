/**
 * Pure text-token grammar for tracker filters. Tokens are `field:value`,
 * `field:op:value`, `field:unary`, or `field:op:a,b`; everything outside a
 * token remains ordinary search text.
 */
import { type TrackerFieldFilter, type TrackerFilterOp } from '../../../runtime/src/plugins/TrackerPlugin/models/trackerFilters';
import type { FieldType } from '../../../tracker-schema/src/browser';
/**
 * The shape the omnibox needs, kept structural so headless callers do not pull
 * in a React component for a type.
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
export declare const OP_TOKENS: Record<TrackerFilterOp, string>;
export declare function isListOp(op: TrackerFilterOp): boolean;
/** `Status changed to` -> `status-changed-to`. */
export declare function slugifyFieldToken(text: string): string;
/**
 * The token text to write for a field.
 *
 * Prefers the human label's slug and falls back to the id when two fields would
 * otherwise share a spelling -- a token has to round-trip to exactly one field.
 */
export declare function tokenKeyForField(field: FilterTokenField, fields: FilterTokenField[]): string;
/** Resolve a typed field token to a field. Exact spellings only. */
export declare function resolveFieldToken(token: string, fields: FilterTokenField[]): FilterTokenField | undefined;
/** Fields worth offering for a partially typed field token, best match first. */
export declare function suggestFields(query: string, fields: FilterTokenField[]): FilterTokenField[];
/** Resolve a typed operator token, restricted to the operators the field allows. */
export declare function resolveOpToken(token: string, field: FilterTokenField | undefined): TrackerFilterOp | undefined;
/**
 * The operator a bare `field:value` token means.
 *
 * Text fields default to `contains` because that is what typing a fragment into
 * a search box implies; everything else defaults to equality.
 */
export declare function defaultOpForField(field: FilterTokenField | undefined): TrackerFilterOp;
/**
 * Build a clause from resolved parts, coercing the operand to the shape
 * `matchesClause` expects for that operator.
 *
 * Returns null when the token is still incomplete (an operator that needs an
 * operand and hasn't got one), so a half-typed token never narrows the list.
 */
export declare function buildClause(field: FilterTokenField, op: TrackerFilterOp, rawValues: string[]): TrackerFieldFilter | null;
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
/**
 * Split the input into its search text and the token under composition.
 *
 * A trailing word only becomes a *token* once it contains a colon. Before that
 * it stays part of the search text (so typing "sta" really does search for
 * "sta") while still offering `Status` in the menu -- the field suggestion is an
 * offer, not a seizure of what was typed.
 */
export declare function parseOmniboxInput(text: string, fields: FilterTokenField[]): OmniboxParse;
/** The operator a draft resolves to, including the `field:me` unary shorthand. */
export declare function resolveDraftOp(draft: TokenDraft): TrackerFilterOp | undefined;
/** The clause a draft would commit to right now, or null if it isn't complete. */
export declare function draftToClause(draft: TokenDraft): TrackerFieldFilter | null;
/** Parse a whole token in one go (`status:any-of:open,done`). */
export declare function parseFilterToken(token: string, fields: FilterTokenField[]): TrackerFieldFilter | null;
/** Write a clause back out as a token, using the shortest spelling that parses. */
export declare function serializeClause(clause: TrackerFieldFilter, fields: FilterTokenField[]): string;
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
/**
 * The menu for the current draft.
 *
 * Ordering is deliberate: values first (the common case), operators after, so
 * `status:` + Enter lands on a status rather than on "is not".
 */
export declare function buildTokenSuggestions(draft: TokenDraft, fields: FilterTokenField[], { limit, tagOptions }?: BuildSuggestionsOptions): TokenSuggestion[];
