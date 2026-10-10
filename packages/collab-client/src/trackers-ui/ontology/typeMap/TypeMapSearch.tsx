/**
 * Find a type or a relationship by name; picking one flies the map to it and
 * selects it. Arrow keys move through the results, Enter picks, Escape clears.
 */
import { useMemo, useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import type { TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import type { MapSelection } from './TypeMapCanvas';

export interface TypeMapSearchProps {
  types: readonly TypeMapType[];
  relationships: readonly TypeMapRelationship[];
  typeById: ReadonlyMap<string, TypeMapType>;
  onPick: (selection: NonNullable<MapSelection>) => void;
}

interface Hit { selection: NonNullable<MapSelection>; label: string; verb?: string; tail?: string; count: number }

export function TypeMapSearch({ types, relationships, typeById, onPick }: TypeMapSearchProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles } = useFloating({
    open,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance(), size({ apply: ({ rects, elements }) => { elements.floating.style.minWidth = `${Math.max(260, rects.reference.width)}px`; } })],
  });

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const plural = (id: string) => typeById.get(id)?.plural ?? id;
    return [
      ...types
        .filter((type) => type.plural.toLowerCase().includes(needle) || type.name.toLowerCase().includes(needle) || type.id.includes(needle))
        .map((type): Hit => ({ selection: { kind: 'type', id: type.id }, label: type.plural, count: type.count })),
      ...relationships
        .filter((relationship) => relationship.verb.toLowerCase().includes(needle) || relationship.predicate.includes(needle))
        .map((relationship): Hit => ({ selection: { kind: 'relationship', id: relationship.id }, label: plural(relationship.from), verb: relationship.verb, tail: plural(relationship.to), count: relationship.statements })),
    ].slice(0, 8);
  }, [query, types, relationships, typeById]);

  const pick = (hit: Hit | undefined) => {
    if (!hit) return;
    setQuery('');
    setOpen(false);
    onPick(hit.selection);
  };
  const shown = open && hits.length > 0;

  return (
    <div className="type-map-search" ref={refs.setReference}>
      <svg className="type-map-search-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></svg>
      <input
        type="search"
        placeholder="Find a type or relationship"
        aria-label="Find a type or relationship"
        autoComplete="off"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { setActive((i) => Math.min(hits.length - 1, i + 1)); event.preventDefault(); }
          else if (event.key === 'ArrowUp') { setActive((i) => Math.max(0, i - 1)); event.preventDefault(); }
          else if (event.key === 'Enter') pick(hits[active]);
          else if (event.key === 'Escape') { setQuery(''); setOpen(false); }
        }}
      />
      {shown && (
        <FloatingPortal>
          <div className="type-map-search-results" ref={refs.setFloating} style={floatingStyles} role="listbox">
            {hits.map((hit, i) => (
              <button
                key={`${hit.selection.kind}:${hit.selection.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                className="type-map-search-hit"
                data-active={i === active ? 'true' : 'false'}
                onMouseDown={(event) => { event.preventDefault(); pick(hit); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="type-map-search-hit-name">{hit.label}{hit.verb && <> <span className="type-map-verb">{hit.verb}</span> {hit.tail}</>}</span>
                <span className="type-map-count">{hit.count}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
