// Test-only stub for `monaco-editor`. No unit test exercises real Monaco
// rendering; this prevents y-monaco / renderer modules from pulling the full
// monaco-editor ESM (which statically imports `.css`, unloadable under vitest).
export const editor = {} as Record<string, unknown>;
export const languages = {} as Record<string, unknown>;
export const Uri = { parse: (v: string) => v };
export class Range {}
export class Selection {}
export const SelectionDirection = { LTR: 0, RTL: 1 };
export default { editor, languages, Uri, Range, Selection, SelectionDirection };
