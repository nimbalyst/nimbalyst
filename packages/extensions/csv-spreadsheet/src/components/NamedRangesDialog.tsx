/**
 * Manage named ranges: add one for the selection, rename (formulas follow),
 * point one at a different range, or delete it. Every change is one command,
 * so one undo step.
 */

import { useEffect, useState } from 'react';
import type { EditorCore } from '../editor/editorCore';
import {
  defineNamedRangeCommand,
  normalizeRangeTarget,
  rangeNameError,
  type NamedRanges,
} from '../sheetMeta/namedRanges';

const FIELD = 'px-2 py-1 text-[12px] bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] min-w-0';

export function NamedRangesDialog({ core, isOpen, names, selectionKey, onClose }: {
  core: EditorCore;
  isOpen: boolean;
  names: NamedRanges;
  selectionKey: string;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState('');
  const [newRange, setNewRange] = useState(selectionKey);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setNewName('');
    setNewRange(selectionKey);
    setError(null);
  }, [isOpen, selectionKey]);

  if (!isOpen) return null;

  /** Define or redefine `name`; `previous` renames an existing entry and every formula using it. */
  const apply = (nameText: string, rangeText: string, previous?: string): boolean => {
    const gridOps = core.gridOpsRef.current;
    if (!gridOps || core.editingLockedRef.current) return false;
    const name = nameText.trim();
    const range = normalizeRangeTarget(rangeText);
    const problem = rangeNameError(name, names, previous) ?? (range ? null : 'Enter a range like A1 or B2:D20.');
    setError(problem);
    if (problem || !range) return false;
    void gridOps.executor.execute(({ state }) => defineNamedRangeCommand(state, name, range, previous));
    return true;
  };

  const remove = (name: string) => {
    const gridOps = core.gridOpsRef.current;
    if (!gridOps || core.editingLockedRef.current) return;
    void gridOps.setMeta((meta) => ({
      namedRanges: Object.fromEntries(Object.entries(meta.namedRanges).filter(([key]) => key !== name)),
    }));
  };

  const entries = Object.entries(names).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="csv-named-ranges-dialog fixed inset-0 bg-black/40 flex items-center justify-center z-[2000]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Named ranges"
        className="bg-nim border border-nim rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.24)] w-[440px] max-h-[80vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nim">
          <h3 className="m-0 text-base font-semibold text-nim">Named ranges</h3>
          <button className="bg-none border-none text-xl text-nim-muted cursor-pointer p-0 leading-none hover:text-nim" onClick={onClose}>&times;</button>
        </div>
        <div className="px-5 py-3 flex flex-col gap-2 overflow-y-auto">
          {entries.length === 0 && <p className="m-0 text-[12px] text-nim-muted">No named ranges yet. Formulas can use a name in place of a range, like =SUM(Sales).</p>}
          {entries.map(([name, range]) => (
            <NamedRangeRow key={name} name={name} range={range} onApply={(next, nextRange) => apply(next, nextRange, name)} onDelete={() => remove(name)} />
          ))}
        </div>
        <form
          className="csv-named-range-add flex items-center gap-2 px-5 py-3 border-t border-nim"
          onSubmit={(event) => {
            event.preventDefault();
            if (apply(newName, newRange)) setNewName('');
          }}
        >
          <input className={`${FIELD} flex-1`} placeholder="Name" aria-label="New name" value={newName} onChange={(event) => setNewName(event.target.value)} />
          <input className={`${FIELD} w-[110px] font-mono`} placeholder="A1:B10" aria-label="New range" value={newRange} onChange={(event) => setNewRange(event.target.value)} />
          <button type="submit" className="px-3 py-1 text-[12px] rounded cursor-pointer bg-[var(--nim-primary)] border border-[var(--nim-primary)] text-white hover:opacity-90">Add</button>
        </form>
        {error && <p className="csv-named-range-error m-0 px-5 pb-3 text-[12px] text-[var(--nim-error)]">{error}</p>}
      </div>
    </div>
  );
}

/** One entry; edits apply on Enter or when the field loses focus. */
function NamedRangeRow({ name, range, onApply, onDelete }: {
  name: string;
  range: string;
  onApply: (name: string, range: string) => boolean;
  onDelete: () => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const [draftRange, setDraftRange] = useState(range);
  useEffect(() => { setDraftName(name); setDraftRange(range); }, [name, range]);
  const commit = () => {
    if (draftName === name && draftRange === range) return;
    if (!onApply(draftName, draftRange)) {
      setDraftName(name);
      setDraftRange(range);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  };
  return (
    <div className="csv-named-range-row flex items-center gap-2">
      <input className={`${FIELD} flex-1`} aria-label={`Name ${name}`} value={draftName}
        onChange={(event) => setDraftName(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
      <input className={`${FIELD} w-[110px] font-mono ${range === '#REF!' ? 'text-[var(--nim-error)]' : ''}`} aria-label={`Range of ${name}`}
        value={draftRange} onChange={(event) => setDraftRange(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
      <button type="button" className="px-2 py-1 text-[12px] rounded cursor-pointer bg-transparent border border-nim text-nim-muted hover:bg-nim-hover"
        aria-label={`Delete ${name}`} onClick={onDelete}>Delete</button>
    </div>
  );
}
