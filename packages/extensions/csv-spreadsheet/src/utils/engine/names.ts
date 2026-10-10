/**
 * Named-range lookup for the parser. Kept free of imports so the engine does
 * not depend on the metadata modules (`sheetMeta/namedRanges.ts` owns the rest).
 */

export type NamedRangeTable = Readonly<Record<string, string>>;

/** What a named range whose cells were all deleted points at. */
export const NAMED_RANGE_REF_ERROR = '#REF!';

const lookups = new WeakMap<NamedRangeTable, Map<string, string>>();

/** The range `name` refers to, case-insensitively; memoized per `names` object. */
export function resolveName(names: NamedRangeTable | undefined, name: string): string | undefined {
  if (!names) return undefined;
  let lookup = lookups.get(names);
  if (!lookup) {
    lookup = new Map(Object.entries(names).map(([key, range]) => [key.toUpperCase(), range]));
    lookups.set(names, lookup);
  }
  return lookup.get(name.toUpperCase());
}
