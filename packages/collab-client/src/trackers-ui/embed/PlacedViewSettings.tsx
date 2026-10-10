import { useRef, useState } from 'react';
import { FloatingFocusManager, FloatingPortal, flip, offset, shift, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerColumnDef } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import type { TrackerFilterField } from '../trackerFilterFields';
import { PlacedViewSettingsSection, VIEW_LAYOUTS, type ViewSettingsSection } from './PlacedViewSettingsSection';

export interface PlacedViewSettingsProps {
  attrs: Readonly<Record<string, string>>;
  fields: readonly TrackerFilterField[];
  availableColumns: TrackerColumnDef[];
  temporary: boolean;
  defaultColumns?: readonly string[];
  onChange(patch: Readonly<Record<string, string | null>>): void;
}

const SECTION_LABELS: Record<ViewSettingsSection, string> = {
  layout: 'Layout', properties: 'Property visibility', filter: 'Filter', sort: 'Sort', group: 'Group',
};
const ROW = 'placed-view-settings-row flex w-full items-center gap-2.5 rounded px-2 py-2 text-left text-[13px] hover:bg-nim-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]';

/** A compact index of settings; each section edits only its own view attributes. */
export function PlacedViewSettings(props: PlacedViewSettingsProps) {
  const { attrs, fields, temporary, defaultColumns } = props;
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<ViewSettingsSection | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const changeOpen = (value: boolean) => { setOpen(value); if (!value) setSection(null); };
  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: changeOpen, placement: 'bottom-end', middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12 })] });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context)]);
  const mode = VIEW_LAYOUTS.find(layout => layout.value === (attrs.mode || 'table'));
  const group = attrs.group || (attrs.mode === 'board' ? 'status' : 'none');
  const count = (value?: string) => value?.split(',').filter(Boolean).length || 0;
  const rows: Array<{ section: ViewSettingsSection; icon: string; summary: string }> = [
    { section: 'layout', icon: mode?.icon || 'table_chart', summary: mode?.label || attrs.mode || 'Table' },
    { section: 'properties', icon: 'visibility', summary: String(attrs.cols ? count(attrs.cols) : (defaultColumns ?? ['title']).length) },
    { section: 'filter', icon: 'filter_list', summary: count(attrs.filter) ? `${count(attrs.filter)} ${count(attrs.filter) === 1 ? 'rule' : 'rules'}` : 'None' },
    { section: 'sort', icon: 'sort', summary: count(attrs.sort) ? `${count(attrs.sort)} ${count(attrs.sort) === 1 ? 'rule' : 'rules'}` : 'Default' },
    { section: 'group', icon: 'view_column', summary: group === 'none' ? 'None' : fields.find(field => field.id === group)?.label || group },
  ];
  const back = () => { setSection(null); requestAnimationFrame(() => refs.floating.current?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`)?.focus()); };
  return <div className="placed-view-settings shrink-0 text-xs" contentEditable={false}>
    <button ref={refs.setReference} type="button" aria-label="View settings" title="View settings" className="inline-flex h-7 w-7 items-center justify-center rounded text-nim-muted hover:bg-nim-hover hover:text-nim focus-visible:outline focus-visible:outline-2" {...getReferenceProps()}>
      <MaterialSymbol icon="tune" size={17} />
    </button>
    {open && <FloatingPortal><FloatingFocusManager context={context} modal={false}>
      <div ref={refs.setFloating} style={{ ...floatingStyles, zIndex: 1000, width: 320, maxHeight: 'min(620px, 80vh)', maxWidth: 'calc(100vw - 24px)' }} className="placed-view-settings-popover flex flex-col overflow-hidden rounded-xl border border-nim bg-nim-secondary text-nim shadow-xl" aria-label="View settings" {...getFloatingProps()}>
        <div className="placed-view-settings-heading flex shrink-0 items-center gap-2 px-3 py-3">
          {section && <button type="button" aria-label="Back to view settings" className="flex h-6 w-6 items-center justify-center rounded text-nim-muted hover:bg-nim-hover" onClick={back}><MaterialSymbol icon="arrow_back" size={17} /></button>}
          <h3 ref={heading} tabIndex={-1} className="min-w-0 flex-1 text-xs font-semibold text-nim-muted outline-none">{section ? SECTION_LABELS[section] : 'View settings'}</h3>
          <button type="button" aria-label="Close view settings" className="flex h-6 w-6 items-center justify-center rounded text-nim-muted hover:bg-nim-hover" onClick={() => changeOpen(false)}><MaterialSymbol icon="close" size={17} /></button>
        </div>
        <div className="placed-view-settings-content min-h-0 overflow-y-auto pb-2">
          {section ? <PlacedViewSettingsSection key={section} {...props} section={section} /> : <div className="placed-view-settings-sections px-1.5">
            {rows.map(row => <button key={row.section} data-section={row.section} type="button" className={ROW} onClick={() => { setSection(row.section); requestAnimationFrame(() => heading.current?.focus()); }}>
              <MaterialSymbol icon={row.icon} size={18} className="text-nim-muted" />
              <span className="flex-1">{SECTION_LABELS[row.section]}</span>
              <span className="max-w-24 truncate text-xs text-nim-faint">{row.summary}</span>
              <MaterialSymbol icon="chevron_right" size={16} className="text-nim-faint" />
            </button>)}
          </div>}
        </div>
        {temporary && <p className="border-t border-nim px-3 py-2 text-[11px] text-nim-muted">Not saved: view only. Changes won’t be saved to this page.</p>}
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </div>;
}
