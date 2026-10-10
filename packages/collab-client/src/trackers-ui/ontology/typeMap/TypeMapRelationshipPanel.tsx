/**
 * One relationship between two types: the sentence both ways, whether the
 * vocabulary declares it, how much it is used and how complete it is, the
 * details its statements carry, and what to do about it. Proposal actions need
 * a writer; a read-only host (the public wiki) gets none.
 */
import { useState } from 'react';
import type { OntologyInspectorWriter } from '../OntologyInspector';
import { typeMapRequestId, type TypeMapModel, type TypeMapRelationship, type TypeMapStatement, type TypeMapType } from '../ontologyLabelMap';
import { createProposalRequest } from '../ontologyWriter';
import type { MapSelection } from './TypeMapCanvas';
import { article, BarRow, Section, Stat, StatusTag, TypeBadge, lower } from './TypeMapParts';

export interface RelationshipActions {
  /** Opens a page by item id; omitted leaves page names as plain text. */
  onOpenPage?: (id: string) => void;
  /** Files proposal requests; null hides every proposal and review action. */
  writer?: OntologyInspectorWriter | null;
}

interface Props extends RelationshipActions {
  model: TypeMapModel;
  relationship: TypeMapRelationship;
  typeById: ReadonlyMap<string, TypeMapType>;
  zoneTone: ReadonlyMap<string, number>;
  onCenter: (selection: NonNullable<MapSelection>) => void;
}

const LIST_LIMIT = 60;

function statusText(relationship: TypeMapRelationship, from: string): string {
  switch (relationship.status) {
    case 'declared-used': return 'Declared and used';
    case 'declared-unused': return 'Declared, nobody uses it yet';
    case 'off-label': return `Used, not declared on ${from}`;
    case 'range-violation': return 'Points at a type outside its range';
  }
}

/** A sentence about the shape of the statements, when one fact stands out. */
export function relationshipNote(relationship: TypeMapRelationship, from: TypeMapType | undefined, to: TypeMapType | undefined, rangeNames: string): string | null {
  const fromName = lower(from?.name ?? relationship.from);
  const fromPlural = lower(from?.plural ?? relationship.from);
  const toPlural = lower(to?.plural ?? relationship.to);
  const n = relationship.statements;
  if (relationship.status === 'range-violation') {
    return `${relationship.verb} should point at ${rangeNames}. ${n} ${n === 1 ? 'statement points' : 'statements point'} at ${toPlural} instead.`;
  }
  if (relationship.status === 'off-label') {
    return `${from?.plural ?? relationship.from} do not list ${relationship.verb}; ${relationship.subjects} ${relationship.subjects === 1 ? fromName : fromPlural} ${relationship.subjects === 1 ? 'has' : 'have'} ${n} of these statements anyway.`;
  }
  if (n >= 3 && relationship.subjects === 1) {
    return `All ${n} statements have ${relationship.list[0]!.subjectTitle} as the subject.`;
  }
  if (n >= 3 && relationship.objects === 1) {
    return `All ${n} statements point at ${relationship.list[0]!.objectTitle}.`;
  }
  return null;
}

function requestText(relationship: TypeMapRelationship, fromName: string, toPlural: string, rangeNames: string): { title: string; body: string[] } {
  const lines = relationship.list.slice(0, 40).map((statement) => `- ${statement.subjectTitle} ${relationship.verb} ${statement.objectTitle} [${statement.claimId ?? statement.subjectId}]`);
  const more = relationship.list.length > 40 ? [`- ...and ${relationship.list.length - 40} more`] : [];
  if (relationship.status === 'range-violation') {
    return {
      title: `Review ${relationship.verb} statements that point at ${toPlural}`,
      body: [`${relationship.predicate} should point at ${rangeNames}. These ${relationship.statements} statements point at ${toPlural} instead. Retarget each one, or propose extending the range.`, '', ...lines, ...more],
    };
  }
  return {
    title: `Declare ${relationship.verb} on ${fromName}`,
    body: [`${relationship.statements} statements use ${relationship.predicate} with a ${lower(fromName)} as the subject, but the ${relationship.from} label does not list it. Propose add-label-property ${relationship.from}.${relationship.predicate}, or fix the statements if they are wrong.`, '', ...lines, ...more],
  };
}

export function TypeMapRelationshipPanel({ model, relationship, typeById, zoneTone, onCenter, onOpenPage, writer }: Props) {
  const [showMissing, setShowMissing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [filing, setFiling] = useState<'idle' | 'busy' | 'filed' | 'failed'>('idle');
  const from = typeById.get(relationship.from);
  const to = typeById.get(relationship.to);
  const fromPlural = from?.plural ?? relationship.from;
  const toPlural = to?.plural ?? relationship.to;
  const rangeNames = relationship.range.map((id) => lower(typeById.get(id)?.name ?? id)).map(article).join(' or ');
  const note = relationshipNote(relationship, from, to, rangeNames);
  const requestId = typeMapRequestId(relationship);
  const requested = filing === 'filed' || model.openRequests.includes(requestId);
  const canFile = Boolean(writer) && relationship.statements > 0 && (relationship.status === 'off-label' || relationship.status === 'range-violation');
  const page = (id: string, title: string) => (onOpenPage
    ? <button type="button" className="type-map-link" onClick={() => onOpenPage(id)}>{title}</button>
    : <b>{title}</b>);
  const statementRow = (statement: TypeMapStatement, key: string) => (
    <div key={key} className="type-map-example">
      {page(statement.subjectId, statement.subjectTitle)} <em>{relationship.verb}</em> {page(statement.objectId, statement.objectTitle)}
      {statement.detail && <span className="type-map-count"> ({statement.detail})</span>}
    </div>
  );

  const file = async () => {
    if (!writer) return;
    setFiling('busy');
    const text = requestText(relationship, from?.name ?? relationship.from, lower(toPlural), rangeNames);
    try {
      await createProposalRequest({ ...writer, now: () => new Date() }, { title: text.title, request: text.body.join('\n'), healthCheck: requestId }, globalThis.crypto.randomUUID());
      setFiling('filed');
    } catch (error) {
      console.error('[type map] filing a proposal request failed', error);
      setFiling('failed');
    }
  };

  return (
    <div className="type-map-relationship-panel" data-relationship-id={relationship.id}>
      <div className="type-map-sentence">
        {from && <TypeBadge type={from} tone={zoneTone.get(from.zone) ?? 0} />}<b>{fromPlural}</b>
        <span className="type-map-verb">{relationship.verb}</span>
        {to && <TypeBadge type={to} tone={zoneTone.get(to.zone) ?? 0} />}<b>{toPlural}</b>
      </div>
      {relationship.inverse && (
        <p>Read the other way: {article(lower(to?.name ?? relationship.to))} <b className="type-map-strong">{relationship.inverse}</b> {lower(fromPlural)}{relationship.symmetric ? ' (it reads the same both ways)' : ''}.</p>
      )}
      <StatusTag status={relationship.status} long={statusText(relationship, from?.name ?? relationship.from)} />
      <div className="type-map-stats">
        <Stat value={relationship.statements} label="statements" />
        <Stat value={relationship.subjects} label={lower(fromPlural)} />
        <Stat value={relationship.objects} label={lower(toPlural)} />
      </div>
      {note && <p className="type-map-note">{note}</p>}

      {relationship.expectation && (
        <Section title="Expectation">
          <BarRow label={`${fromPlural} with ${relationship.expectation.min === 1 ? 'one' : `${relationship.expectation.min}+`}`} value={relationship.expectation.met} of={relationship.expectation.total} text={`${relationship.expectation.met}/${relationship.expectation.total}`} />
          <p>
            {`Every ${lower(from?.name ?? relationship.from)} should have at least ${relationship.expectation.min}. `}
            {relationship.expectation.missing.length === 0 ? 'All do.' : `${relationship.expectation.missing.length} ${relationship.expectation.missing.length === 1 ? "doesn't" : "don't"}. `}
            {relationship.expectation.missing.length > 0 && (
              <button type="button" className="type-map-link" onClick={() => setShowMissing((shown) => !shown)}>{showMissing ? 'Hide them' : 'Show them'}</button>
            )}
          </p>
          {showMissing && (
            <div className="type-map-list">
              {relationship.expectation.missing.slice(0, LIST_LIMIT).map((missing) => <div key={missing.id} className="type-map-example">{page(missing.id, missing.title)}</div>)}
              {relationship.expectation.missing.length > LIST_LIMIT && <p>{`and ${relationship.expectation.missing.length - LIST_LIMIT} more`}</p>}
            </div>
          )}
        </Section>
      )}

      {relationship.topTargets.length > 1 && (
        <Section title={`Most linked ${lower(toPlural)}`}>
          {relationship.topTargets.map((target) => (
            <BarRow key={target.id} label={target.title} value={target.count} of={relationship.topTargets[0]!.count} text={String(target.count)} onClick={onOpenPage ? () => onOpenPage(target.id) : undefined} />
          ))}
        </Section>
      )}
      {relationship.list.length > 0 && (
        <Section title={showAll ? `All ${relationship.list.length} statements` : 'Examples'}>
          {(showAll ? relationship.list.slice(0, LIST_LIMIT * 5) : relationship.list.slice(0, 3)).map((statement, i) => statementRow(statement, `${statement.claimId ?? statement.subjectId}:${i}`))}
        </Section>
      )}
      {relationship.status === 'declared-unused' && (
        <p className="type-map-note">{`No ${lower(fromPlural)} use it yet. It appears here because the ${lower(from?.name ?? relationship.from)} label lists it.`}</p>
      )}

      <div className="type-map-actions">
        {canFile && (
          <button type="button" className="type-map-primary" disabled={requested || filing === 'busy'} onClick={() => void file()} title="Files a proposal request for an agent or a teammate to act on">
            {requested ? 'Request filed'
              : relationship.status === 'off-label' ? `Propose declaring it on ${from?.name ?? relationship.from}`
                : 'Review wrong statements'}
          </button>
        )}
        {relationship.list.length > 3 && (
          <button type="button" className={canFile ? '' : 'type-map-primary'} onClick={() => setShowAll((shown) => !shown)}>{showAll ? 'Show examples only' : 'Open statements'}</button>
        )}
        <button type="button" onClick={() => onCenter({ kind: 'relationship', id: relationship.id })}>Center</button>
      </div>
      {filing === 'failed' && <p className="type-map-error">The request could not be filed. Try again.</p>}
    </div>
  );
}
