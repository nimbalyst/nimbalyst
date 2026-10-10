/** A temporary full view keeps the authored definition, including relative dates. */
export interface PlacedViewHandoff {
    label: string;
    attrs: Readonly<Record<string, string>>;
}
/** Query strings are untrusted; invalid definitions must never become an unfiltered All view. */
export declare function parsePlacedViewHandoff(value: string): PlacedViewHandoff;
