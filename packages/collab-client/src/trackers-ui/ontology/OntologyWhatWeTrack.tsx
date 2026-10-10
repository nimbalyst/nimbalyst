/**
 * "What we track": the inspector's main view. A plain sentence with clickable
 * counts, category cards grouped as the market, our product, customers and the
 * work, each with how completely its relationships are recorded, and a detail
 * page per category with its members and, behind a disclosure, how it is
 * stored.
 */
import type { KeyboardEvent } from 'react';
import { formatCount, type DomainCategory, type DomainGap, type DomainModel } from './ontologyDomain';
import { OntologyNeighborhood } from './OntologyNeighborhood';
import {
  CategoryLines,
  categoryName,
  groupDotClass,
  OntologyLineRow,
  OntologyMembersTable,
  OntologySchemaDisclosure,
  type GapAction,
  type OpenCategory,
} from './OntologyParts';
import { OntologyRail, type ProposalSummary } from './OntologyRail';

export interface OntologyViewProps {
  model: DomainModel;
  gapAction: (gap: DomainGap) => GapAction;
  proposals: readonly ProposalSummary[];
  onOpenProposal: (id: string) => void;
  onOpenItem?: (itemId: string) => void;
}

function relativeDay(iso: string | null, now: number): string {
  if (!iso) return '';
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'last change today';
  if (days === 1) return 'last change yesterday';
  return `last change ${days} days ago`;
}

/** A card is a block of text, so it is a div that acts as a button rather than a button holding divs. */
function activate(run: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: run,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        run();
      }
    },
  } as const;
}

function OntologyCard({ model, category, onOpen, gapAction }: {
  model: DomainModel;
  category: DomainCategory;
  onOpen: OpenCategory;
  gapAction: (gap: DomainGap) => GapAction;
}) {
  const gaps = model.gaps.filter((gap) => category.gapIds.includes(gap.id));
  if (category.ghost) {
    const gap = gaps[0];
    return (
      <div className="ontology-card ontology-card-ghost" data-category={category.id} {...activate(() => gap && gapAction(gap).open())}>
        <div className="ontology-card-head">
          <span className="ontology-dot ontology-dot-warn" />
          <span className="ontology-card-name">{category.name}</span>
          <span className="ontology-card-count">not tracked</span>
        </div>
        <div className="ontology-card-role">{category.role}</div>
        <div className="ontology-card-example">{category.example}</div>
        <div className="ontology-card-lines" />
        <div className="ontology-card-gap">Propose tracking {category.name.toLowerCase()} &rarr;</div>
      </div>
    );
  }
  // Only a gap about this category: a shared one (stale facts) would repeat on every card it touches.
  // A missing relationship leads, since that is what the card's lines are about.
  const own = gaps.filter((gap) => gap.tone === 'gap' && gap.categoryIds[0] === category.id);
  const firstGap = own.find((gap) => gap.check === 'domain-line') ?? own[0];
  return (
    <div className={`ontology-card${category.us ? ' ontology-card-us' : ''}`} data-category={category.id} {...activate(() => onOpen(category.id))}>
      <div className="ontology-card-head">
        <span className={groupDotClass(category.group)} />
        <span className="ontology-card-name">{category.name}</span>
        {!category.us && (
          <span className="ontology-card-count">
            {formatCount(category.count)}
            {category.countLabel && <small>{category.countLabel}</small>}
          </span>
        )}
      </div>
      <div className="ontology-card-role">{category.role}</div>
      <div className="ontology-card-example">{category.example}</div>
      <div className="ontology-card-lines">
        {category.lines.map((line) => (
          <OntologyLineRow key={line.id} category={category} line={line} targetName={categoryName(model, line.targetId)} dense />
        ))}
      </div>
      {firstGap && (
        <div className="ontology-card-gap">
          <span className="ontology-dot ontology-dot-warn" />
          {firstGap.title}
        </div>
      )}
    </div>
  );
}

export function OntologySummary({ model, onOpen, now }: { model: DomainModel; onOpen: OpenCategory; now: number }) {
  const meta = [
    `${formatCount(model.meta.pages)} wiki pages`,
    `${formatCount(model.meta.statements)} statements`,
    `${formatCount(model.meta.types)} tracker types`,
    relativeDay(model.meta.lastChange, now),
  ].filter(Boolean);
  return (
    <>
      <p className="ontology-hero">
        {model.summary.map((part, index) => (part.categoryId
          ? <button key={index} type="button" className="ontology-hero-count" onClick={() => onOpen(part.categoryId!)}>{part.text}</button>
          : <span key={index}>{part.text}</span>))}
      </p>
      <div className="ontology-meta">{meta.join(' · ')}</div>
    </>
  );
}

export function OntologyOverview({ model, onOpen, gapAction, now }: {
  model: DomainModel;
  onOpen: OpenCategory;
  gapAction: (gap: DomainGap) => GapAction;
  now: number;
}) {
  const byId = new Map(model.categories.map((category) => [category.id, category]));
  return (
    <div className="ontology-overview">
      <OntologySummary model={model} onOpen={onOpen} now={now} />
      {model.groups.map((group) => (
        <section key={group.id} className="ontology-group" data-group={group.id}>
          <div className="ontology-section-head">
            <h3>{group.label}</h3>
            <span>{group.question}</span>
          </div>
          <div className="ontology-cards">
            {group.categoryIds.map((id) => (
              <OntologyCard key={id} model={model} category={byId.get(id)!} onOpen={onOpen} gapAction={gapAction} />
            ))}
          </div>
        </section>
      ))}
      {model.also.length > 0 && (
        <div className="ontology-also">
          <span>Also tracked</span>
          {model.also.map((chip) => (
            <span key={chip.id} className="ontology-chip">{chip.name} <i>{formatCount(chip.count)}</i></span>
          ))}
        </div>
      )}
    </div>
  );
}

export function OntologyCategoryDetail({ model, category, onOpen, onBack, onOpenItem, onOpenGap, backLabel }: {
  model: DomainModel;
  category: DomainCategory;
  onOpen: OpenCategory;
  onBack: () => void;
  onOpenItem?: (itemId: string) => void;
  onOpenGap: (gapId: string) => void;
  backLabel: string;
}) {
  const group = model.groups.find((entry) => entry.id === category.group);
  return (
    <div className="ontology-category-detail" data-category={category.id}>
      <button type="button" className="ontology-back" onClick={onBack}>&larr; {backLabel}</button>
      <div className="ontology-kicker"><span className={groupDotClass(category.group)} />{group?.label}</div>
      <div className="ontology-title">
        <h2>{category.name}</h2>
        {!category.us && <span>{formatCount(category.count)}{category.countLabel ? ` ${category.countLabel}` : ''}</span>}
      </div>
      <p className="ontology-blurb">{category.blurb}</p>
      <div className="ontology-detail-grid">
        <div>
          <OntologyNeighborhood model={model} categoryId={category.id} onOpen={onOpen} onOpenGap={onOpenGap} />
          <div className="ontology-label">{category.us ? 'Recorded about us' : 'Members'}</div>
          <OntologyMembersTable table={category.table} onOpenItem={onOpenItem} />
        </div>
        <div>
          <CategoryLines model={model} category={category} onOpen={onOpen} first />
          <OntologySchemaDisclosure schema={category.schema} />
        </div>
      </div>
    </div>
  );
}

/** The whole "What we track" screen: overview or one category, with the gaps rail beside it. */
export function OntologyWhatWeTrack({ model, gapAction, proposals, onOpenProposal, onOpenItem, selected, onSelect, now }: OntologyViewProps & {
  selected: string | null;
  onSelect: (categoryId: string | null) => void;
  now: number;
}) {
  const category = selected ? model.categories.find((entry) => entry.id === selected && !entry.ghost) ?? null : null;
  const openGap = (gapId: string) => {
    const gap = model.gaps.find((entry) => entry.id === gapId);
    if (gap) gapAction(gap).open();
  };
  const own = category ? model.gaps.filter((gap) => category.gapIds.includes(gap.id)) : model.gaps;
  return (
    <div className="ontology-track">
      <div className="ontology-track-main">
        {category ? (
          <OntologyCategoryDetail
            model={model}
            category={category}
            onOpen={(id) => onSelect(id)}
            onBack={() => onSelect(null)}
            onOpenItem={onOpenItem}
            onOpenGap={openGap}
            backLabel="What we track"
          />
        ) : (
          <OntologyOverview model={model} onOpen={(id) => onSelect(id)} gapAction={gapAction} now={now} />
        )}
      </div>
      <OntologyRail
        title={category ? 'Worth fixing here' : 'Worth fixing'}
        subtitle={category
          ? (own.length ? `Specific to ${category.name.toLowerCase()}.` : `Nothing specific to ${category.name.toLowerCase()}.`)
          : own.length ? 'Found by comparing what you record against what you could. Each one drafts a proposal you can accept or reject part by part.' : 'Nothing to fix.'}
        gaps={own}
        elsewhere={category ? model.gaps.filter((gap) => !category.gapIds.includes(gap.id)) : undefined}
        gapAction={gapAction}
        proposals={proposals}
        onOpenProposal={onOpenProposal}
      />
    </div>
  );
}
