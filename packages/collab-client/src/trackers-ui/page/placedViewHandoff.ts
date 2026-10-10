/** A temporary full view keeps the authored definition, including relative dates. */
export interface PlacedViewHandoff {
  label: string;
  attrs: Readonly<Record<string, string>>;
}

/** Query strings are untrusted; invalid definitions must never become an unfiltered All view. */
export function parsePlacedViewHandoff(value: string): PlacedViewHandoff {
  if (value.length > 65536) throw new Error('The view definition is too large.');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid view definition.');
  const { label, attrs } = parsed as Partial<PlacedViewHandoff>;
  if (typeof label !== 'string' || !attrs || typeof attrs !== 'object' || Array.isArray(attrs)
    || Object.values(attrs).some(value => typeof value !== 'string')) throw new Error('Invalid view definition.');
  return { label, attrs };
}
