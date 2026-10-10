/**
 * A label's review on its type page: the health checks about the label, each
 * of which can become a proposal request, and the open proposals that touch
 * it, reviewed in the same drawer the inspector uses. Members only; a public
 * reader never sees health or proposals.
 */
import { useMemo, useState } from 'react';
import type { LabelRegistry, PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildKnowledgeGraph, entityKind, ENTITY_TYPE, type HealthItem } from './ontologyKnowledge';
import { effectiveLabelRegistry } from './ontologyLabels';
import { proposalsTouchingLabel } from './ontologyLabelProposals';
import { ONTOLOGY_PROPOSAL_TYPE, openProposalsByCheck, proposalRequestFor, type PlanEnv } from './ontologyProposals';
import { ontologyFieldValue, ontologyRecordTitle, type OntologyRecordLike } from './ontologyRecords';
import type { WriteContext } from './ontologyWriter';
import type { OntologyInspectorWriter } from './OntologyInspector';
import { OntologyProposalDrawer, type DrawerTarget } from './OntologyProposalDrawer';
import { proposalStatusLabel } from './OntologyRail';
import './ontologyInspector.css';
import './ontologyTypes.css';

export interface OntologyLabelReviewProps {
  labelId: string;
  /** Health items about this label (`labelIds` includes it). */
  health: ReadonlyArray<HealthItem<OntologyRecordLike>>;
  types: readonly TrackerDataModel[];
  predicates?: readonly PredicateDefinition[] | null;
  labels?: LabelRegistry | null;
  records: readonly OntologyRecordLike[];
  /** Null for a reader who may not write. */
  writer: OntologyInspectorWriter | null;
  onOpenItem?: (itemId: string) => void;
}

export function OntologyLabelReview({ labelId, health, types, predicates = null, labels = null, records, writer, onOpenItem }: OntologyLabelReviewProps) {
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const graph = useMemo(() => buildKnowledgeGraph(records), [records]);
  const proposalRecords = useMemo(() => records.filter((record) => record.primaryType === ONTOLOGY_PROPOSAL_TYPE && !record.archived), [records]);
  const proposalsById = useMemo(() => new Map(proposalRecords.map((record) => [record.id, record])), [proposalRecords]);
  const openByCheck = useMemo(() => openProposalsByCheck(proposalRecords), [proposalRecords]);
  const touching = useMemo(() => proposalsTouchingLabel(proposalRecords, labelId), [proposalRecords, labelId]);
  const env = useMemo<PlanEnv>(() => {
    const kind = types.find((model) => model.type === ENTITY_TYPE)?.fields.find((field) => field.name === 'kind');
    const predicateLabels = new Map((predicates ?? []).map((predicate) => [predicate.id, predicate.label]));
    return {
      kindOptions: new Set((kind?.options ?? []).map((option) => option.value)),
      predicateLabel: (id) => predicateLabels.get(id) ?? id.replace(/-/g, ' '),
      newId: () => globalThis.crypto.randomUUID(),
      labels: effectiveLabelRegistry(labels, { kindOptions: kind?.options, observedKinds: graph.entities.map(entityKind) }),
      isPredicate: (id) => predicateLabels.has(id),
    };
  }, [types, predicates, labels, graph]);
  const context = useMemo<WriteContext | null>(() => (writer ? { ...writer, now: () => new Date() } : null), [writer]);

  return (
    <div className="ontology-label-review" data-label-id={labelId}>
      {health.length === 0 ? (
        <p className="ontology-label-review-empty">Nothing to fix.</p>
      ) : (
        <ul>
          {health.map((item) => {
            const existing = openByCheck.get(item.id);
            return (
              <li key={item.id} className="ontology-label-review-row" data-health={item.id} data-severity={item.severity}>
                <span title={item.detail}>{item.title}</span>
                {item.severity !== 'info' && (
                  <button
                    type="button"
                    className="ontology-link"
                    onClick={() => setDrawer(existing
                      ? { kind: 'proposal', id: existing.id }
                      : { kind: 'request', draft: proposalRequestFor(item), detail: item.detail, pages: item.items })}
                  >
                    {existing ? 'View proposal' : 'Fix'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {touching.length > 0 && (
        <>
          <div className="ontology-label">Open proposals</div>
          <ul>
            {touching.map((proposal) => {
              const status = ontologyFieldValue(proposal, 'status');
              return (
                <li key={proposal.id} className="ontology-label-review-row">
                  <button type="button" className="ontology-link" onClick={() => setDrawer({ kind: 'proposal', id: proposal.id })}>
                    {ontologyRecordTitle(proposal).replace(/^Improve: /, '')}
                  </button>
                  <span className="ontology-status" data-status={status}>{proposalStatusLabel(typeof status === 'string' && status ? status : 'proposed')}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {drawer && (
        <OntologyProposalDrawer
          target={drawer}
          onClose={() => setDrawer(null)}
          proposals={proposalsById}
          graph={graph}
          env={env}
          context={context}
          onOpenItem={onOpenItem}
          onOpenProposal={(id) => setDrawer({ kind: 'proposal', id })}
        />
      )}
    </div>
  );
}
