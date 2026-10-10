/**
 * The ontology inspector: "what does our team keep track of, and how do those
 * things relate?" Read-only admin view of every tracker type; every gap opens a
 * proposal, and proposals are the only way anything here changes. The label
 * type map and per-label review live on the wiki's Types pages
 * (`OntologyTypeMap`, `OntologyLabelReview`); `onOpenTypes` links there.
 *
 * Host-agnostic: the host passes the room's schemas, predicate registry (null
 * when it cannot read one) and records, and a writer when this reader may
 * create and decide proposals. The web console's Tracker setup screen and the
 * desktop settings tab mount the same component.
 */
import { useMemo, useState } from 'react';
import type { LabelRegistry, PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildDomainModel, suggestStructureRequest, type DomainGap } from './ontologyDomain';
import { buildKnowledgeGraph, entityKind, ENTITY_TYPE } from './ontologyKnowledge';
import { effectiveLabelRegistry } from './ontologyLabels';
import { ONTOLOGY_PROPOSAL_TYPE, openProposalsByCheck, proposalRequestFor, type PlanEnv } from './ontologyProposals';
import { ontologyFieldValue, ontologyRecordTitle, type OntologyRecordLike } from './ontologyRecords';
import type { TrackerCommandFn, WriteContext } from './ontologyWriter';
import type { GapAction } from './OntologyParts';
import { OntologyProposalDrawer, type DrawerTarget } from './OntologyProposalDrawer';
import type { ProposalSummary } from './OntologyRail';
import { OntologyWhatWeTrack } from './OntologyWhatWeTrack';
import './ontologyInspector.css';

/** Kept for hosts that pass it; the concept map moved to the wiki's Types page. */
export type OntologyInspectorView = 'track';

export interface OntologyInspectorWriter {
  command: TrackerCommandFn;
  /** The project new proposals are created in. */
  workspace: string;
  actor: string | null;
}

export interface OntologyInspectorProps {
  types: readonly TrackerDataModel[];
  /** Null when the host cannot read the room's registry; predicates are then keyed off claim ids. */
  predicates?: readonly PredicateDefinition[] | null;
  /** The room's label registry; empty reads through the kind stand-in. */
  labels?: LabelRegistry | null;
  records: readonly OntologyRecordLike[];
  /** Null for a reader who may not write: proposals can be read but not created or decided. */
  writer: OntologyInspectorWriter | null;
  /** False until the room's first snapshot arrives, so an empty room is not mistaken for one still loading. */
  loaded?: boolean;
  onOpenItem?: (itemId: string) => void;
  initialView?: OntologyInspectorView;
  /** Opens the wiki's Types section, where labels are browsed and reviewed. */
  onOpenTypes?: () => void;
  /** Injected in tests; the inspector otherwise judges stale facts against the time it opened. */
  now?: number;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set(['proposed', 'accepted']);
const SUGGEST_CHECK = 'suggest-structure';

export function OntologyInspector({ types, predicates = null, labels = null, records, writer, loaded = true, onOpenItem, onOpenTypes, now: fixedNow }: OntologyInspectorProps) {
  const [openedAt] = useState(() => Date.now());
  const now = fixedNow ?? openedAt;
  const [trackSelected, setTrackSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);

  const model = useMemo(() => buildDomainModel({ types, predicates, labels, records, now }), [types, predicates, labels, records, now]);
  const graph = useMemo(() => buildKnowledgeGraph(records), [records]);
  const proposalRecords = useMemo(
    () => records
      .filter((record) => record.primaryType === ONTOLOGY_PROPOSAL_TYPE && !record.archived)
      .sort((a, b) => String(b.system?.createdAt ?? '').localeCompare(String(a.system?.createdAt ?? ''))),
    [records],
  );
  const proposalsById = useMemo(() => new Map(proposalRecords.map((record) => [record.id, record])), [proposalRecords]);
  const openByCheck = useMemo(() => openProposalsByCheck(proposalRecords), [proposalRecords]);
  const proposals = useMemo<ProposalSummary[]>(() => {
    const summaries = proposalRecords.map((record) => {
      const status = ontologyFieldValue(record, 'status');
      return { id: record.id, title: ontologyRecordTitle(record).replace(/^Improve: /, ''), status: typeof status === 'string' && status ? status : 'proposed' };
    });
    return [...summaries.filter((entry) => OPEN_STATUSES.has(entry.status)), ...summaries.filter((entry) => !OPEN_STATUSES.has(entry.status))];
  }, [proposalRecords]);

  const env = useMemo<PlanEnv>(() => {
    const kind = types.find((model) => model.type === ENTITY_TYPE)?.fields.find((field) => field.name === 'kind');
    const predicateLabels = new Map((predicates ?? []).map((predicate) => [predicate.id, predicate.label]));
    const predicateIds = new Set((predicates ?? []).map((predicate) => predicate.id));
    return {
      kindOptions: new Set((kind?.options ?? []).map((option) => option.value)),
      predicateLabel: (id) => predicateLabels.get(id) ?? id.replace(/-/g, ' '),
      newId: () => globalThis.crypto.randomUUID(),
      labels: effectiveLabelRegistry(labels, { kindOptions: kind?.options, observedKinds: graph.entities.map(entityKind) }),
      isPredicate: (id) => predicateIds.has(id),
    };
  }, [types, predicates, labels, graph]);
  const context = useMemo<WriteContext | null>(() => (writer ? { ...writer, now: () => new Date() } : null), [writer]);

  const openProposal = (id: string) => setDrawer({ kind: 'proposal', id });
  const gapAction = (gap: DomainGap): GapAction => {
    const existing = openByCheck.get(gap.id);
    if (existing) return { label: 'View proposal', open: () => openProposal(existing.id) };
    return {
      label: gap.tone === 'opportunity' ? 'Propose' : 'Fix',
      open: () => setDrawer({ kind: 'request', draft: proposalRequestFor(gap), detail: gap.detail, pages: gap.items }),
    };
  };
  const suggest = () => {
    const existing = openByCheck.get(SUGGEST_CHECK);
    if (existing) {
      openProposal(existing.id);
      return;
    }
    const draft = suggestStructureRequest(model);
    setDrawer({ kind: 'request', draft, detail: 'The agent reviews what you track and drafts the changes with the most effect, each as its own proposal.', pages: [] });
  };

  return (
    <div className="ontology-inspector" data-view="track">
      <div className="ontology-toolbar">
        <span className="ontology-toolbar-note">Read-only. Changes go through proposals.</span>
        {onOpenTypes && <button type="button" className="ontology-link" onClick={onOpenTypes}>Browse labels in the wiki's Types</button>}
        <button type="button" className="ontology-button" onClick={suggest}>Ask the agent to suggest improvements</button>
      </div>
      {!loaded ? (
        <p className="ontology-empty ontology-loading">Loading what this project tracks…</p>
      ) : (
        <OntologyWhatWeTrack
          model={model}
          gapAction={gapAction}
          proposals={proposals}
          onOpenProposal={openProposal}
          onOpenItem={onOpenItem}
          selected={trackSelected}
          onSelect={(id) => {
            const target = id ? model.categories.find((category) => category.id === id) : null;
            if (target?.ghost) {
              const gap = model.gaps.find((entry) => target.gapIds.includes(entry.id));
              if (gap) gapAction(gap).open();
              return;
            }
            setTrackSelected(id);
          }}
          now={now}
        />
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
          onOpenProposal={openProposal}
        />
      )}
    </div>
  );
}
