/**
 * The proposal drawer. Opened from a gap it shows what the request will ask an
 * agent to fix and writes it as an `ontology-proposal` request. Opened on a
 * proposal it shows each drafted change with the pages it touches and a
 * before/after, accept or reject per change, apply and undo. Every decision is
 * written back to the proposal, so a rejected change stays on record.
 */
import { useMemo, useState } from 'react';
import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { KnowledgeGraph } from './ontologyKnowledge';
import {
  decideChange,
  decisionOf,
  isLive,
  parseProposalChanges,
  parseUndoRecord,
  planOntologyChange,
  SCHEMA_CHANGE_TYPES,
  type ChangeDecision,
  type ChangePlan,
  type OntologyChange,
  type PlanEnv,
  type ProposalRequestDraft,
} from './ontologyProposals';
import { ontologyFieldValue, ontologyRecordTitle, type OntologyRecordLike } from './ontologyRecords';
import { applyAcceptedChanges, createProposalRequest, saveDecisions, undoAppliedChanges, type WriteContext } from './ontologyWriter';
import { proposalStatusLabel } from './OntologyRail';

export type DrawerTarget =
  | { kind: 'request'; draft: ProposalRequestDraft; detail: string; pages: readonly OntologyRecordLike[] }
  | { kind: 'proposal'; id: string };

const PAGE_PREVIEW = 10;

function text(record: OntologyRecordLike, field: string): string {
  const value = ontologyFieldValue(record, field);
  return typeof value === 'string' ? value.trim() : '';
}

function PageLinks({ pages, onOpenItem, limit = PAGE_PREVIEW }: { pages: readonly OntologyRecordLike[]; onOpenItem?: (id: string) => void; limit?: number }) {
  if (!pages.length) return null;
  const shown = pages.slice(0, limit);
  return (
    <div className="ontology-change-pages">
      {shown.map((page) => (onOpenItem
        ? <button key={page.id} type="button" className="ontology-link" onClick={() => onOpenItem(page.id)}>{ontologyRecordTitle(page)}</button>
        : <span key={page.id}>{ontologyRecordTitle(page)}</span>))}
      {pages.length > shown.length && <span className="ontology-empty">and {pages.length - shown.length} more</span>}
    </div>
  );
}

export function OntologyProposalDrawer({ target, onClose, proposals, graph, env, context, onOpenItem, onOpenProposal }: {
  target: DrawerTarget;
  onClose: () => void;
  proposals: ReadonlyMap<string, OntologyRecordLike>;
  graph: KnowledgeGraph;
  env: PlanEnv;
  context: WriteContext | null;
  onOpenItem?: (itemId: string) => void;
  /** Switch the drawer to a proposal, e.g. the request just written. */
  onOpenProposal: (id: string) => void;
}) {
  const { refs, context: floating } = useFloating({ open: true, onOpenChange: (open) => { if (!open) onClose(); } });
  const dismiss = useDismiss(floating, { outsidePressEvent: 'mousedown' });
  const role = useRole(floating, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);
  const proposal = target.kind === 'proposal' ? proposals.get(target.id) ?? null : null;
  return (
    <FloatingPortal>
      <FloatingOverlay className="ontology-scrim" lockScroll>
        <FloatingFocusManager context={floating} initialFocus={-1}>
          <aside ref={refs.setFloating} className="ontology-drawer" aria-label="Ontology proposal" {...getFloatingProps()}>
            {target.kind === 'request' ? (
              <RequestPanel target={target} context={context} onClose={onClose} onOpenItem={onOpenItem} onCreated={onOpenProposal} />
            ) : proposal ? (
              <ProposalPanel key={proposal.id} proposal={proposal} graph={graph} env={env} context={context} onClose={onClose} onOpenItem={onOpenItem} />
            ) : (
              <>
                <DrawerHead kicker="Proposal" title="Waiting for the proposal" onClose={onClose} />
                <div className="ontology-drawer-body"><p className="ontology-empty">The request was sent. It appears here as soon as the project syncs it back.</p></div>
              </>
            )}
          </aside>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

function DrawerHead({ kicker, title, reason, onClose }: { kicker: string; title: string; reason?: string; onClose: () => void }) {
  return (
    <div className="ontology-drawer-head">
      <div className="ontology-drawer-kicker">
        <span>{kicker}</span>
        <button type="button" className="ontology-drawer-close" aria-label="Close panel" onClick={onClose}>&#x2715;</button>
      </div>
      <h3>{title}</h3>
      {reason && <p>{reason}</p>}
    </div>
  );
}

const READ_ONLY = 'You can read this project but not write to it, so proposals cannot be created or decided here.';

function RequestPanel({ target, context, onClose, onOpenItem, onCreated }: {
  target: Extract<DrawerTarget, { kind: 'request' }>;
  context: WriteContext | null;
  onClose: () => void;
  onOpenItem?: (itemId: string) => void;
  onCreated: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createProposalRequest(context, target.draft, globalThis.crypto.randomUUID());
      onCreated(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <>
      <DrawerHead kicker="New proposal · an agent drafts the changes" title={target.draft.title.replace(/^Improve: /, '')} reason={target.detail} onClose={onClose} />
      <div className="ontology-drawer-body">
        {target.pages.length > 0 && (
          <>
            <div className="ontology-label">Affects {target.pages.length} {target.pages.length === 1 ? 'page' : 'pages'}</div>
            <PageLinks pages={target.pages} onOpenItem={onOpenItem} />
          </>
        )}
        <div className="ontology-request">
          <span>The request the agent receives:</span>
          <pre>{target.draft.request}</pre>
        </div>
      </div>
      <div className="ontology-drawer-note">
        Nothing changes until you apply. An agent with the wiki skills (/wiki:update) drafts the changes; you accept or reject each one here. Rejected changes are remembered so they are not suggested again.
      </div>
      <div className="ontology-drawer-foot">
        <span className="ontology-drawer-status">{context ? '' : READ_ONLY}</span>
        <button type="button" className="ontology-button ontology-button-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="ontology-button ontology-button-primary" disabled={!context || busy} onClick={() => { void send(); }}>
          {busy ? 'Sending…' : 'Ask the agent to draft this'}
        </button>
        {error && <div className="ontology-drawer-error" role="alert">{error}</div>}
      </div>
    </>
  );
}

function ProposalPanel({ proposal, graph, env, context, onClose, onOpenItem }: {
  proposal: OntologyRecordLike;
  graph: KnowledgeGraph;
  env: PlanEnv;
  context: WriteContext | null;
  onClose: () => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const parsed = useMemo(() => parseProposalChanges(ontologyFieldValue(proposal, 'changes')), [proposal]);
  const plans = useMemo(() => new Map(parsed.changes.map((change) => [change.id, planOntologyChange(change, graph, env)])), [parsed, graph, env]);
  const undoRecord = useMemo(() => parseUndoRecord(ontologyFieldValue(proposal, 'undo')), [proposal]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'apply' | 'undo' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = text(proposal, 'status') || 'proposed';
  const request = text(proposal, 'request');
  const reason = text(proposal, 'reason');
  const ready = parsed.changes.filter((change) => decisionOf(change) === 'accepted' && !isLive(change) && !plans.get(change.id)?.blocked);
  const writes = ready.reduce((sum, change) => sum + (plans.get(change.id)?.ops.length ?? 0), 0);
  const canUndo = undoRecord.entries.some((entry) => !entry.undoneAt);
  const accepted = parsed.changes.filter((change) => decisionOf(change) === 'accepted').length;
  const rejected = parsed.changes.filter((change) => decisionOf(change) === 'rejected').length;
  const pending = parsed.changes.length - accepted - rejected;

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };
  const decide = (change: OntologyChange, decision: ChangeDecision, rejectReason?: string) => context && run(async () => {
    await saveDecisions(context, proposal.id, decideChange(parsed.changes, change.id, decision, context.actor, context.now().toISOString(), rejectReason));
    return null;
  });
  const apply = () => context && run(async () => {
    const result = await applyAcceptedChanges(proposal, graph, env, context);
    if (result.error) throw new Error(`Stopped: ${result.error}. The writes that ran are recorded and can be undone.`);
    return `Applied ${result.applied.length} ${result.applied.length === 1 ? 'change' : 'changes'}.${result.blocked.length ? ` ${result.blocked.length} waiting on a schema change.` : ''}`;
  });
  const undo = () => context && run(async () => {
    const result = await undoAppliedChanges(proposal, context);
    if (result.error) throw new Error(`Undo stopped: ${result.error}.`);
    return `Undid ${result.undone.length} ${result.undone.length === 1 ? 'change' : 'changes'}.`;
  });

  return (
    <>
      <DrawerHead
        kicker={`Proposal · ${proposalStatusLabel(status)}${proposal.issueKey ? ` · ${proposal.issueKey}` : ''}`}
        title={ontologyRecordTitle(proposal).replace(/^Improve: /, '')}
        reason={reason || undefined}
        onClose={onClose}
      />
      <div className="ontology-drawer-body">
        {parsed.changes.length === 0 && (
          <div className="ontology-request">
            <strong>Waiting for an agent to draft changes.</strong>
            <div>In a Nimbalyst agent session with the wiki skills, run /wiki:update and ask it to draft the pending ontology proposals.</div>
            {request && <pre>{request}</pre>}
          </div>
        )}
        {parsed.errors.length > 0 && (
          <ul className="ontology-drawer-error">{parsed.errors.map((line) => <li key={line}>{line}</li>)}</ul>
        )}
        {parsed.changes.map((change, index) => (
          <ChangeRow
            key={change.id}
            index={index}
            change={change}
            plan={plans.get(change.id)!}
            canDecide={Boolean(context) && !busy}
            onDecide={(decision, why) => { void decide(change, decision, why); }}
            onOpenItem={onOpenItem}
          />
        ))}
      </div>
      <div className="ontology-drawer-note">Nothing changes until you apply. Applied proposals keep an undo record; rejected changes are remembered so they are not suggested again.</div>
      <div className="ontology-drawer-foot">
        <span className="ontology-drawer-status">
          {!context ? READ_ONLY : busy ? 'Writing…' : message ?? (parsed.changes.length === 0 ? '' : pending ? `${pending} of ${parsed.changes.length} to decide` : `${accepted} accepted, ${rejected} rejected`)}
        </span>
        {confirming ? (
          <>
            <span className="ontology-drawer-status">
              {confirming === 'apply' ? `Apply ${ready.length} ${ready.length === 1 ? 'change' : 'changes'} (${writes} ${writes === 1 ? 'write' : 'writes'})?` : 'Undo every applied change in this proposal?'}
            </span>
            <button type="button" className="ontology-button ontology-button-ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            <button type="button" className="ontology-button ontology-button-primary" disabled={busy} onClick={() => { void (confirming === 'apply' ? apply() : undo()); }}>
              {confirming === 'apply' ? 'Apply' : 'Undo'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ontology-button ontology-button-ghost" onClick={onClose}>Close</button>
            {canUndo && <button type="button" className="ontology-button" disabled={!context || busy} onClick={() => setConfirming('undo')}>Undo applied</button>}
            {parsed.changes.length > 0 && (
              <button type="button" className="ontology-button ontology-button-primary" disabled={!context || busy || ready.length === 0} onClick={() => setConfirming('apply')}>
                {ready.length ? `Apply ${ready.length} ${ready.length === 1 ? 'change' : 'changes'}` : 'Apply'}
              </button>
            )}
          </>
        )}
        {error && <div className="ontology-drawer-error" role="alert">{error}</div>}
      </div>
    </>
  );
}

function ChangeRow({ index, change, plan, canDecide, onDecide, onOpenItem }: {
  index: number;
  change: OntologyChange;
  plan: ChangePlan;
  canDecide: boolean;
  onDecide: (decision: ChangeDecision, rejectReason?: string) => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const decision = decisionOf(change);
  const live = isLive(change);
  const schema = SCHEMA_CHANGE_TYPES.has(change.type);
  const [preview, setPreview] = useState(false);
  // Rejecting asks why, inline: the agent reads the reason before proposing again.
  const [rejecting, setRejecting] = useState<string | null>(null);
  const marker = live || decision === 'accepted' ? '✓' : decision === 'rejected' ? '✕' : String(index + 1);
  return (
    <div className="ontology-change" data-decision={live ? 'accepted' : decision}>
      <div className="ontology-change-top">
        <span className="ontology-change-no">{marker}</span>
        <div>
          <div className="ontology-change-title">{plan.summary}</div>
          <div className="ontology-change-meta">
            {schema ? 'Schema change, applied by an agent' : `Affects ${plan.pages.length} ${plan.pages.length === 1 ? 'page' : 'pages'}`}
            {plan.pages.length > 0 && <> · <button type="button" className="ontology-link" onClick={() => setPreview(!preview)}>{preview ? 'hide pages' : 'preview'}</button></>}
            {live && ' · applied'}
            {change.undoneAt && !live && ' · undone'}
          </div>
          {change.reason && <div className="ontology-change-meta">{change.reason}</div>}
        </div>
      </div>
      {preview && <div className="ontology-change-indent"><PageLinks pages={plan.pages} onOpenItem={onOpenItem} limit={40} /></div>}
      {plan.example && (
        <div className="ontology-change-indent ontology-change-example">
          {plan.example.before.map((line, i) => <div key={`b${i}`} className="ontology-change-before">Before: {line.label}: {line.value}</div>)}
          {plan.example.after.map((line, i) => <div key={`a${i}`} className="ontology-change-after">After: {line.label}: {line.value}</div>)}
        </div>
      )}
      {decision === 'accepted' && !live && plan.blocked && <div className="ontology-change-indent ontology-change-blocked">{plan.blocked}</div>}
      {decision === 'rejected' && change.rejectReason && <div className="ontology-change-indent ontology-change-meta">Rejected: {change.rejectReason}</div>}
      {!live && (
        <div className="ontology-change-indent ontology-change-actions">
          {rejecting === null ? (
            <>
              <button
                type="button"
                className={`ontology-button ontology-button-sm${decision === 'accepted' ? ' ontology-button-accepted' : ''}`}
                aria-pressed={decision === 'accepted'}
                disabled={!canDecide}
                onClick={() => onDecide(decision === 'accepted' ? 'pending' : 'accepted')}
              >
                Accept
              </button>
              <button
                type="button"
                className={`ontology-button ontology-button-sm${decision === 'rejected' ? ' ontology-button-rejected' : ''}`}
                aria-pressed={decision === 'rejected'}
                disabled={!canDecide}
                onClick={() => (decision === 'rejected' ? onDecide('pending') : setRejecting(''))}
              >
                Reject
              </button>
            </>
          ) : (
            <form className="ontology-change-actions" onSubmit={(event) => { event.preventDefault(); onDecide('rejected', rejecting); setRejecting(null); }}>
              <input
                placeholder="Why not? (optional, the agent reads this)"
                aria-label="Reason for rejecting"
                value={rejecting}
                onChange={(event) => setRejecting(event.target.value)}
                autoFocus
              />
              <button type="submit" className="ontology-button ontology-button-sm" disabled={!canDecide}>Reject</button>
              <button type="button" className="ontology-button ontology-button-sm ontology-button-ghost" onClick={() => setRejecting(null)}>Cancel</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
