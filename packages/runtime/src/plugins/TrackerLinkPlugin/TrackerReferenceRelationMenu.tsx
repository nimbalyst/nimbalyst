/**
 * The "Link as" row of a tracker reference's preview card.
 *
 * A link between two typed pages may state one named relation. The choices are
 * the registry predicates allowed for (this page's type, the linked page's
 * type), plus "Plain link". Choosing one is stored on the link itself
 * (`rel=` in the markdown title), so the body stays the source of truth and the
 * Links section and the index read it from there.
 */

import type { JSX } from 'react';
import * as React from 'react';
import {
  relationsForPair,
  type PageRelationOption,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';

/** The slice of the tracker registry the relation choice reads. */
export interface TrackerRelationRegistry {
  getAllPredicates(): PredicateDefinition[];
  getPredicate(id: string): PredicateDefinition | undefined;
  get(type: string): { extends?: string } | undefined;
}

export function trackerReferenceRelationOptions(
  registry: TrackerRelationRegistry,
  sourceType: string,
  targetType: string,
): PageRelationOption[] {
  return relationsForPair(
    registry.getAllPredicates(),
    sourceType,
    targetType,
    type => registry.get(type)?.extends,
  );
}

export function trackerReferenceRelationLabel(
  registry: TrackerRelationRegistry,
  relation: string,
): string {
  return registry.getPredicate(relation)?.label ?? relation;
}

export interface TrackerReferenceRelationMenuProps {
  options: PageRelationOption[];
  /** The stored relation; null for a plain link. */
  relation: string | null;
  relationLabel?: string;
  /** Absent in read-only editors: the stored relation shows, with no choice. */
  onChoose?: (relation: string | null) => void;
}

export function TrackerReferenceRelationMenu({
  options,
  relation,
  relationLabel,
  onChoose,
}: TrackerReferenceRelationMenuProps): JSX.Element | null {
  if (!onChoose) {
    if (!relation) return null;
    return (
      <div className="tracker-reference-relation" style={sectionStyle}>
        <span style={{ color: 'var(--nim-text-muted)' }}>Linked as </span>
        <span style={{ color: 'var(--nim-text)', fontWeight: 500 }}>{relationLabel ?? relation}</span>
      </div>
    );
  }
  if (options.length === 0 && !relation) return null;

  // A stored relation the registry no longer allows for this pair still shows,
  // selected, so the reader sees what the link says and can clear it.
  const rows: Array<{ id: string | null; label: string; hint: string }> = options.map(option => ({
    id: option.predicateId,
    label: option.label,
    hint: option.inverseLabel,
  }));
  if (relation && !options.some(option => option.predicateId === relation)) {
    rows.push({ id: relation, label: relationLabel ?? relation, hint: '' });
  }
  rows.push({ id: null, label: 'Plain link', hint: 'no relation' });

  return (
    <div className="tracker-reference-relation" style={sectionStyle}>
      <div style={{ color: 'var(--nim-text-muted)', marginBottom: '6px' }}>Link as</div>
      <div
        className="tracker-reference-relation-menu"
        role="radiogroup"
        aria-label="Link as"
        style={{
          padding: '4px',
          borderRadius: '6px',
          border: '1px solid var(--nim-border)',
          background: 'var(--nim-bg-secondary)',
        }}
      >
        {rows.map(row => {
          const selected = row.id === relation;
          return (
            <button
              key={row.id ?? ''}
              type="button"
              role="radio"
              aria-checked={selected}
              className="tracker-reference-relation-option"
              data-relation={row.id ?? ''}
              onClick={() => {
                if (!selected) onChoose(row.id);
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: '8px',
                width: '100%',
                padding: '4px 8px',
                border: 'none',
                borderRadius: '4px',
                background: selected ? 'var(--nim-bg-selected)' : 'transparent',
                color: selected ? 'var(--nim-text)' : 'var(--nim-text-muted)',
                font: 'inherit',
                textAlign: 'left',
                cursor: selected ? 'default' : 'pointer',
              }}
            >
              <span>{row.label}</span>
              {row.hint ? (
                <small style={{ color: 'var(--nim-text-faint)', fontSize: '11px' }}>{row.hint}</small>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  marginTop: '10px',
  paddingTop: '10px',
  borderTop: '1px solid var(--nim-border)',
};
