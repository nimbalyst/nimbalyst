/**
 * Reading a fence body: a YAML mapping, or CSV rows. Read-only on purpose --
 * the node keeps the text, and a block that wants to change one key edits
 * the text rather than dumping a parsed object (which would reorder keys,
 * drop comments, and reformat values the author wrote).
 */
export type FenceYamlResult = {
    ok: true;
    value: Record<string, unknown>;
} | {
    ok: false;
    error: string;
};
export declare function parseFenceYaml(source: string): FenceYamlResult;
/**
 * The body with top-level `key: value` lines set, editing only those lines:
 * an unindented `key:` line is replaced, a missing one is added at the top
 * (never the end, which could land inside a `data: |` block), and a null
 * value removes the line. Numbers are rounded; strings are quoted only when
 * YAML needs it. Indented lines (block text, a nested spec) are not touched.
 * If the edit would not read back as the requested values (a flow mapping, a
 * `---` marker), the body is returned unchanged.
 */
export declare function setFenceYamlValues(body: string, values: Readonly<Record<string, number | string | null>>): string;
/**
 * CSV with a header row: quoted cells (`"a, b"`, `""` for a quote), blank
 * lines skipped. A cell that reads as a finite number becomes a number.
 */
export declare function parseFenceCsv(text: string): Array<Record<string, string | number>>;
