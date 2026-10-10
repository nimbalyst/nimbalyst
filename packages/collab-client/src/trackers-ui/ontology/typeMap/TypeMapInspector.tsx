/**
 * The panel beside the map: an overview with nothing selected, a type's panel,
 * or a relationship's (`TypeMapRelationshipPanel`).
 */
import type { TypeMapModel, TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import type { MapSelection } from './TypeMapCanvas';
import { BarRow, Section, Stat, StatusTag, TypeBadge, lower } from './TypeMapParts';
import { TypeMapRelationshipPanel, type RelationshipActions } from './TypeMapRelationshipPanel';

export interface TypeMapInspectorProps extends RelationshipActions {
  model: TypeMapModel;
  typeById: ReadonlyMap<string, TypeMapType>;
  /** The relationships the map currently shows (toggles applied). */
  relationships: readonly TypeMapRelationship[];
  zoneTone: ReadonlyMap<string, number>;
  selection: MapSelection;
  /** Select and fly to. */
  onPick: (selection: NonNullable<MapSelection>) => void;
  onCenter: (selection: NonNullable<MapSelection>) => void;
  onOpenLabel: (id: string) => void;
  onOpenUnlabeled?: () => void;
}

export function TypeMapInspector(props: TypeMapInspectorProps) {
  const { selection, typeById, model } = props;
  const type = selection?.kind === 'type' ? typeById.get(selection.id) : undefined;
  const relationship = selection?.kind === 'relationship' ? model.relationships.find((entry) => entry.id === selection.id) : undefined;
  return (
    <aside className="type-map-inspector select-text" aria-label="Details" data-testid="type-map-inspector">
      {type ? <TypePanel {...props} type={type} />
        : relationship ? <TypeMapRelationshipPanel {...props} relationship={relationship} />
          : <Overview {...props} />}
    </aside>
  );
}

function RelationshipRow({ relationship, typeById, zoneTone, side, onPick }: {
  relationship: TypeMapRelationship;
  typeById: ReadonlyMap<string, TypeMapType>;
  zoneTone: ReadonlyMap<string, number>;
  /** `out`: this type is the subject; `in`: the object; `both`: name both ends. */
  side: 'out' | 'in' | 'both';
  onPick: (selection: NonNullable<MapSelection>) => void;
}) {
  const from = typeById.get(relationship.from);
  const to = typeById.get(relationship.to);
  const badgeType = side === 'out' ? to : from;
  return (
    <button type="button" className="type-map-row" onClick={() => onPick({ kind: 'relationship', id: relationship.id })}>
      {badgeType && <TypeBadge type={badgeType} tone={zoneTone.get(badgeType.zone) ?? 0} />}
      <span className="type-map-row-text">
        {side !== 'out' && <>{from?.plural ?? relationship.from} </>}
        <span className="type-map-verb">{relationship.verb}</span>
        {side !== 'in' && <> {to?.plural ?? relationship.to}</>}
      </span>
      {relationship.status !== 'declared-used' && <StatusTag status={relationship.status} />}
      <span className="type-map-count">{relationship.statements || ''}</span>
    </button>
  );
}

function Overview({ model, relationships, typeById, zoneTone, onPick, onOpenLabel, onOpenUnlabeled }: TypeMapInspectorProps) {
  const used = relationships.filter((relationship) => relationship.statements > 0);
  const unused = model.relationships.filter((relationship) => relationship.statements === 0).length;
  const statements = used.reduce((sum, relationship) => sum + relationship.statements, 0);
  const decisions = model.relationships.filter((relationship) => relationship.statements > 0 && (relationship.status === 'off-label' || relationship.status === 'range-violation'));
  return (
    <div className="type-map-overview">
      <h2>All types</h2>
      <p>
        {`${model.types.length} types in ${model.zones.length} ${model.zones.length === 1 ? 'domain' : 'domains'}. `}
        {`${statements} statements link pages to each other through ${used.length} ${used.length === 1 ? 'relationship' : 'relationships'}`}
        {unused ? `; ${unused} more ${unused === 1 ? 'is' : 'are'} declared but unused.` : '.'}
      </p>
      {used.length > 0 && (
        <Section title="Most used relationships">
          <div className="type-map-list">
            {used.slice(0, 6).map((relationship) => <RelationshipRow key={relationship.id} relationship={relationship} typeById={typeById} zoneTone={zoneTone} side="both" onPick={onPick} />)}
          </div>
        </Section>
      )}
      {decisions.length > 0 && (
        <Section title="Needs a decision">
          <div className="type-map-list">
            {decisions.map((relationship) => <RelationshipRow key={relationship.id} relationship={relationship} typeById={typeById} zoneTone={zoneTone} side="both" onPick={onPick} />)}
          </div>
        </Section>
      )}
      <Section title="Key">
        <div className="type-map-legend">
          <span><i data-style="used" data-thick="true" />Declared and used; thicker means more statements</span>
          <span><i data-style="unused" />Declared, nobody uses it yet</span>
          <span><i data-style="off-label" />Used, but not declared on that type</span>
          <span><i data-style="violation" />Points at a type outside its range</span>
        </div>
      </Section>
      {(model.structure.length > 0 || (onOpenUnlabeled && model.unlabeled > 0)) && (
        <Section title="Page structure and triage">
          <div className="type-map-list">
            {model.structure.map((entry) => (
              <button key={entry.id} type="button" className="type-map-row" onClick={() => onOpenLabel(entry.id)}>
                <span className="type-map-row-text">{entry.plural}</span><span className="type-map-count">{entry.count}</span>
              </button>
            ))}
            {onOpenUnlabeled && model.unlabeled > 0 && (
              <button type="button" className="type-map-row type-map-unlabeled" onClick={onOpenUnlabeled}>
                <span className="type-map-row-text">Unlabeled pages</span><span className="type-map-count">{model.unlabeled}</span>
              </button>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function TypePanel({ type, relationships, typeById, zoneTone, onPick, onCenter, onOpenLabel }: TypeMapInspectorProps & { type: TypeMapType }) {
  const out = relationships.filter((relationship) => relationship.from === type.id);
  const into = relationships.filter((relationship) => relationship.to === type.id && relationship.from !== type.id);
  const total = (list: readonly TypeMapRelationship[]) => list.reduce((sum, relationship) => sum + relationship.statements, 0);
  return (
    <div className="type-map-type-panel" data-type-id={type.id}>
      <h2><TypeBadge type={type} tone={zoneTone.get(type.zone) ?? 0} />{type.plural}</h2>
      <p>
        {type.description}
        {type.broader.length > 0 && ` Kind of ${type.broader.join(', ')}.`}
        {!type.declared && ' Pages carry this label, but the registry does not declare it.'}
      </p>
      <div className="type-map-stats">
        <Stat value={type.count} label={type.count === 1 ? 'page' : 'pages'} />
        <Stat value={total(out)} label="links out" />
        <Stat value={total(into)} label="links in" />
      </div>
      {type.properties.length > 0 && (
        <Section title="How complete">
          {type.properties.map((property) => (
            <BarRow key={property.id} label={property.name} value={property.filled} of={type.count} text={type.count ? `${property.filled}/${type.count}` : '-'} />
          ))}
        </Section>
      )}
      <Section title="Links to">
        <div className="type-map-list">
          {out.length ? out.map((relationship) => <RelationshipRow key={relationship.id} relationship={relationship} typeById={typeById} zoneTone={zoneTone} side="out" onPick={onPick} />) : <p>Nothing yet.</p>}
        </div>
      </Section>
      <Section title="Linked from">
        <div className="type-map-list">
          {into.length ? into.map((relationship) => <RelationshipRow key={relationship.id} relationship={relationship} typeById={typeById} zoneTone={zoneTone} side="in" onPick={onPick} />) : <p>Nothing yet.</p>}
        </div>
      </Section>
      <div className="type-map-actions">
        <button type="button" className="type-map-primary" onClick={() => onOpenLabel(type.id)}>{`Open ${lower(type.plural)} table`}</button>
        <button type="button" onClick={() => onCenter({ kind: 'type', id: type.id })}>Center</button>
      </div>
    </div>
  );
}
