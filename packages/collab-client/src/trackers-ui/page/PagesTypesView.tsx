/**
 * A Pages section's Types: every type in the section, as a map (a line
 * between types that relate, through relationship fields and page-link
 * relations) or as a table. A type opens its type page from either. "New
 * type..." opens the dialog the host renders (`renderNewType`). The host keeps
 * which view shows: the web console in the URL, the desktop in the tab.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { OntologyTypeMap } from '../ontology/LazyOntologyTypes';
import { useTrackerDataSelector } from '../useTrackerData';
import { buildPagesTypeMap, buildPagesTypeTable, type PagesTypeMapItem, type PagesTypeTableRow } from './pagesTypeMap';
import type { PagesOpenOptions, PagesSearchLane } from './PagesSearchView';

export type PagesTypesViewMode = 'map' | 'table';

export interface PagesTypesViewProps {
  lane: PagesSearchLane;
  /** The project name, or a project switcher, in the header. */
  title?: React.ReactNode;
  /** The types placed in the section's tree, for the table's "In tree" column. */
  typePlacements: ReadonlyArray<{ typeId: string }>;
  view: PagesTypesViewMode;
  onViewChange: (view: PagesTypesViewMode) => void;
  /** `newTab`: Cmd/Ctrl was held on the click. */
  onOpenType: (typeId: string, options: PagesOpenOptions) => void;
  /** The New type dialog; absent hides the button (no tracker writes here). */
  renderNewType?: (props: { onClose: () => void; onCreated: (typeId: string) => void }) => React.ReactNode;
}

const VIEWS: ReadonlyArray<{ id: PagesTypesViewMode; label: string; icon: string }> = [
  { id: 'map', label: 'Map', icon: 'hub' },
  { id: 'table', label: 'Table', icon: 'table_rows' },
];

export function PagesTypesView({ lane, title, typePlacements, view, onViewChange, onOpenType, renderNewType }: PagesTypesViewProps): React.JSX.Element {
  const records = useTrackerDataSelector((store) => store.records);
  const [registryRevision, setRegistryRevision] = useState(0);
  useEffect(() => globalRegistry.onChange(() => setRegistryRevision((value) => value + 1)), []);
  const [creating, setCreating] = useState(false);

  // registryRevision invalidates the memos when types change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const types = useMemo(() => globalRegistry.getListed().filter((type) => ((type.sharing ?? 'personal') === 'team') === (lane === 'team')), [lane, registryRevision]);
  const items = records as readonly PagesTypeMapItem[];
  const model = useMemo(() => (view === 'map' ? buildPagesTypeMap({
    types,
    items,
    predicates: globalRegistry.getAllPredicates(),
    itemTitle: (item) => getRecordTitle(item as Parameters<typeof getRecordTitle>[0]),
  }) : null), [view, types, items]);
  const rows = useMemo(() => (view === 'table'
    ? buildPagesTypeTable({ types, items, placedTypeIds: new Set(typePlacements.map((placement) => placement.typeId)) })
    : []), [view, types, items, typePlacements]);
  const sectionName = lane === 'team' ? 'Team' : 'Personal';

  return (
    <div className="pages-types-view flex h-full min-h-0 flex-col bg-nim" data-testid="pages-types-view" data-lane={lane} data-view={view}>
      <header className="pages-types-header flex shrink-0 items-center gap-3 border-b border-nim px-4 py-2 select-text">
        <div className="flex min-w-0 items-center gap-2">
          <MaterialSymbol icon="category" size={18} className="text-nim-muted" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-nim">{title ?? sectionName}</span>
            <span className="truncate text-[11px] text-nim-faint">{`Types · ${types.length}`}</span>
          </div>
        </div>
        <div className="pages-types-switch mx-auto flex items-center rounded-md border border-nim p-0.5" role="tablist" aria-label="Types view">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              data-view={entry.id}
              className={`flex cursor-pointer items-center gap-1 rounded border-none px-2.5 py-1 text-[12px] ${view === entry.id ? 'bg-nim-tertiary text-nim' : 'bg-transparent text-nim-muted hover:text-nim'}`}
              onClick={() => onViewChange(entry.id)}
            >
              <MaterialSymbol icon={entry.icon} size={14} />
              {entry.label}
            </button>
          ))}
        </div>
        {renderNewType && (
          <button
            type="button"
            className="pages-types-new flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-nim bg-transparent px-2.5 py-1.5 text-[12px] text-nim hover:bg-nim-hover"
            onClick={() => setCreating(true)}
          >
            <MaterialSymbol icon="add" size={15} />
            New type...
          </button>
        )}
      </header>
      <div className="pages-types-body min-h-0 flex-1 overflow-auto">
        {types.length === 0 ? (
          <p className="m-0 px-6 py-10 text-center text-[13px] text-nim-muted">
            {`${sectionName} has no page types yet. A type gives pages the same fields, and its page lists them as a table.`}
          </p>
        ) : model ? (
          <div className="h-full p-3">
            <OntologyTypeMap model={model} inspector={false} onOpenLabel={(typeId, options) => onOpenType(typeId, options ?? { newTab: false })} />
          </div>
        ) : (
          <PagesTypesTable rows={rows} onOpenType={onOpenType} />
        )}
      </div>
      {creating && renderNewType?.({
        onClose: () => setCreating(false),
        onCreated: (typeId) => {
          setCreating(false);
          onOpenType(typeId, { newTab: false });
        },
      })}
    </div>
  );
}

function PagesTypesTable({ rows, onOpenType }: { rows: readonly PagesTypeTableRow[]; onOpenType: PagesTypesViewProps['onOpenType'] }) {
  const cell = 'px-2 py-2 align-top';
  return (
    <table className="pages-types-table w-full table-fixed border-collapse text-[13px] select-text">
      <thead>
        <tr className="sticky top-0 z-10 border-b border-nim bg-nim text-left text-[11px] uppercase tracking-wide text-nim-muted">
          <th className="py-1.5 pl-4 pr-2 font-medium">Type</th>
          <th className="w-[160px] px-2 py-1.5 font-medium">Extends</th>
          <th className="w-[80px] px-2 py-1.5 text-right font-medium">Pages</th>
          <th className="w-[80px] px-2 py-1.5 text-right font-medium">Fields</th>
          <th className="w-[90px] px-2 py-1.5 text-right font-medium">Relations</th>
          <th className="w-[80px] py-1.5 pl-2 pr-4 font-medium">In tree</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const model = globalRegistry.get(row.id);
          const open = (event: React.MouseEvent | React.KeyboardEvent) => onOpenType(row.id, { newTab: event.metaKey || event.ctrlKey });
          return (
            <tr
              key={row.id}
              className="pages-types-row cursor-pointer border-b border-nim hover:bg-nim-hover"
              data-type-id={row.id}
              tabIndex={0}
              onClick={open}
              onKeyDown={(event) => { if (event.key === 'Enter') open(event); }}
            >
              <td className={`${cell} pl-4`}>
                <span className="flex min-w-0 items-center gap-2">
                  <MaterialSymbol icon={model?.icon || 'category'} size={15} style={model?.color ? { color: model.color } : undefined} />
                  <span className="truncate text-nim">{row.name}</span>
                </span>
              </td>
              <td className={`${cell} truncate text-nim-muted`}>{row.extendsName ?? ''}</td>
              <td className={`${cell} text-right tabular-nums text-nim-muted`}>{row.pages}</td>
              <td className={`${cell} text-right tabular-nums text-nim-muted`}>{row.fields}</td>
              <td className={`${cell} text-right tabular-nums text-nim-muted`}>{row.relations}</td>
              <td className={`${cell} pr-4 text-nim-muted`}>{row.placed ? 'Yes' : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
