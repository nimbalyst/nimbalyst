/** Small pieces the type map's inspector panels share. */
import type { ReactNode } from 'react';
import type { RelationshipStatus, TypeMapType } from '../ontologyLabelMap';
import { initials } from './TypeMapCanvas';

export function TypeBadge({ type, tone }: { type: Pick<TypeMapType, 'name'>; tone: number }) {
  return <span className="type-map-badge" data-tone={tone} aria-hidden="true">{initials(type.name)}</span>;
}

const STATUS_TEXT: Record<RelationshipStatus, { short: string; tone: string }> = {
  'declared-used': { short: 'declared', tone: 'ok' },
  'declared-unused': { short: 'unused', tone: 'off' },
  'off-label': { short: 'not declared', tone: 'warn' },
  'range-violation': { short: 'wrong target', tone: 'err' },
};

export function StatusTag({ status, long }: { status: RelationshipStatus; long?: string }) {
  const { short, tone } = STATUS_TEXT[status];
  return <span className="type-map-tag" data-tone={tone}>{long ?? short}</span>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="type-map-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function BarRow({ label, value, of, text, onClick }: { label: ReactNode; value: number; of: number; text: string; onClick?: () => void }) {
  const width = of ? Math.min(100, Math.round((100 * value) / of)) : 0;
  const body = (
    <>
      <span className="type-map-bar-label">{label}</span>
      <i className="type-map-bar-track"><b style={{ width: `${width}%` }} /></i>
      <span className="type-map-count">{text}</span>
    </>
  );
  return onClick
    ? <button type="button" className="type-map-bar" onClick={onClick}>{body}</button>
    : <div className="type-map-bar">{body}</div>;
}

export function Stat({ value, label }: { value: number; label: string }) {
  return <div className="type-map-stat"><b>{value}</b><span>{label}</span></div>;
}

export function lower(text: string): string {
  return text.toLowerCase();
}

/** "a market", "an organization". */
export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`;
}
