/**
 * "New type..." for Pages: names, an icon, a few fields and an optional
 * parent, written as the same schema `tracker_define_type` writes, in the
 * section the dialog was opened from. The host owns the write (`defineType`);
 * this dialog then places the type in the tree, at the section root or under
 * the page it was opened from, so it shows up and Set type can use it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
import type { CollabTypeLane } from '../docs/collabTypeResolver';
import type { CollabDocsSession } from '../docs/session';
import type { SharedParentKind } from '../docs/types';
import {
  buildNewTypeSchema,
  newTypeIdFromName,
  validateNewTypeDraft,
  type NewTypeFieldDraft,
  type NewTypeFieldKind,
  type NewTypeSchema,
} from '../docs/newTypeSchema';

export interface NewTypeDialogProps {
  lane: CollabTypeLane;
  /** The section's types: parent and relation choices, and the collision check. */
  resolver: CollabTypeTreeResolver;
  session: CollabDocsSession;
  /** Where the new type is placed; null or omitted is the section root. */
  parent?: { id: string; kind: SharedParentKind } | null;
  /**
   * The host's write. Rejects with a message a person can read. `syncing` means
   * it is written here but the team's server has not confirmed it yet.
   */
  defineType: (schema: NewTypeSchema) => Promise<void | { status: 'syncing' }>;
  onCreated?: (typeId: string) => void;
  onClose: () => void;
}

const ICONS = ['label', 'folder_special', 'person', 'groups', 'storefront', 'lightbulb', 'flag', 'description', 'build', 'public'];
const KINDS: Array<{ kind: NewTypeFieldKind; label: string }> = [
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' },
  { kind: 'select', label: 'Choice' },
  { kind: 'date', label: 'Date' },
  { kind: 'person', label: 'Person' },
  { kind: 'relation', label: 'Link to type' },
];

/** "Libraries" -> "Library", "Boxes" -> "Box", "Customers" -> "Customer". */
function singularOf(plural: string): string {
  const name = plural.trim();
  if (/ies$/i.test(name)) return name.slice(0, -3) + 'y';
  if (/(s|x|ch|sh)es$/i.test(name)) return name.slice(0, -2);
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name;
}

const controlClass = 'px-2 py-1.5 rounded-md text-[13px] bg-nim-secondary text-nim border border-nim outline-none focus:border-[var(--nim-primary)]';
const inputClass = `w-full ${controlClass}`;
const labelClass = 'block text-[11px] uppercase tracking-wider font-semibold text-nim-faint mb-1';

export function NewTypeDialog({ lane, resolver, session, parent, defineType, onCreated, onClose }: NewTypeDialogProps) {
  const [pluralName, setPluralName] = useState('');
  const [singularEdited, setSingularEdited] = useState<string | null>(null);
  const [icon, setIcon] = useState('label');
  const [extendsTypeId, setExtendsTypeId] = useState<string | null>(null);
  const [fields, setFields] = useState<NewTypeFieldDraft[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  /** Set once the type is written but the team has not confirmed it; the dialog then only closes. */
  const [syncingNotice, setSyncingNotice] = useState<string | null>(null);

  const types = useMemo(() => resolver.listedTypes?.() ?? [], [resolver]);
  const singularName = singularEdited ?? singularOf(pluralName);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, running]);

  const updateField = (index: number, patch: Partial<NewTypeFieldDraft>) =>
    setFields((current) => current.map((field, i) => (i === index ? { ...field, ...patch } : field)));

  const create = async () => {
    const draft = { pluralName, singularName, icon, extendsTypeId, fields };
    const candidate = newTypeIdFromName(singularName);
    const existingTypeIds = new Set(types.map((type) => type.typeId));
    if (candidate && resolver.typeName(candidate) !== null) existingTypeIds.add(candidate);
    const problems = validateNewTypeDraft(draft, { existingTypeIds });
    setErrors(problems);
    if (problems.length > 0) return;

    setRunning(true);
    try {
      const schema = buildNewTypeSchema(draft, lane);
      const written = await defineType(schema);
      const placed = await session.placeType(schema.type, parent?.id ?? null, parent?.kind);
      // The type exists either way; a failed placement only leaves it unplaced.
      if (!placed.ok) setErrors([`The type was created but could not be added to the tree: ${placed.error}`]);
      onCreated?.(schema.type);
      if (written && written.status === 'syncing') {
        setSyncingNotice(`${draft.pluralName.trim()} is saved on this computer and still syncing to the team. Teammates see it once the team's server confirms it.`);
        return;
      }
      if (placed.ok) onClose();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
    } finally {
      setRunning(false);
    }
  };

  return createPortal(
    <div
      className="new-type-dialog-overlay fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={() => { if (!running) onClose(); }}
      data-testid="new-type-dialog"
    >
      <div
        className="new-type-dialog w-[480px] max-w-[92vw] max-h-[80vh] flex flex-col bg-nim border border-nim rounded-lg shadow-xl overflow-hidden"
        role="dialog"
        aria-label="New type"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-nim">
          <div className="text-sm font-medium text-nim">New type</div>
          <div className="text-xs text-nim-faint mt-0.5">
            {lane === 'team' ? 'Team · shared with this project.' : 'Personal · on this device. Available offline.'}
          </div>
        </div>

        <div className="new-type-dialog-body flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className={labelClass}>Name (plural)</span>
              <input
                className={inputClass}
                value={pluralName}
                placeholder="Customers"
                autoFocus
                onChange={(event) => setPluralName(event.target.value)}
                data-testid="new-type-plural"
              />
            </label>
            <label className="flex-1">
              <span className={labelClass}>One of them</span>
              <input
                className={inputClass}
                value={singularName}
                placeholder="Customer"
                onChange={(event) => setSingularEdited(event.target.value)}
                data-testid="new-type-singular"
              />
            </label>
          </div>

          <div>
            <span className={labelClass}>Icon</span>
            <div className="new-type-icons flex flex-wrap gap-1">
              {ICONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  aria-pressed={icon === name}
                  className={`w-7 h-7 rounded-md inline-flex items-center justify-center ${icon === name ? 'bg-[var(--nim-primary)]/20 text-nim' : 'text-nim-muted hover:bg-nim-hover'}`}
                  onClick={() => setIcon(name)}
                >
                  <MaterialSymbol icon={name} size={16} />
                </button>
              ))}
            </div>
          </div>

          <label>
            <span className={labelClass}>Kind of</span>
            <select
              className={inputClass}
              value={extendsTypeId ?? ''}
              onChange={(event) => setExtendsTypeId(event.target.value || null)}
              data-testid="new-type-extends"
            >
              <option value="">Nothing (a new kind of page)</option>
              {types.map((type) => <option key={type.typeId} value={type.typeId}>{type.name}</option>)}
            </select>
          </label>

          <div>
            <span className={labelClass}>Fields</span>
            {fields.some((field) => field.kind === 'relation') && <p className="mb-2 text-xs text-nim-muted">Link to type adds a reference field. Named relations in page sentences use the project's relation definitions.</p>}
            <div className="flex flex-col gap-1.5">
              {fields.map((field, index) => (
                <div key={index} className="new-type-field-row flex items-center gap-1.5">
                  <input
                    className={`${controlClass} flex-1 min-w-0`}
                    value={field.label}
                    placeholder="Field name"
                    onChange={(event) => updateField(index, { label: event.target.value })}
                    data-testid={`new-type-field-label-${index}`}
                  />
                  <select
                    className={`${controlClass} w-[120px] shrink-0`}
                    value={field.kind}
                    onChange={(event) => updateField(index, { kind: event.target.value as NewTypeFieldKind })}
                    data-testid={`new-type-field-kind-${index}`}
                  >
                    {KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
                  </select>
                  {field.kind === 'select' ? (
                    <input
                      className={`${controlClass} flex-1 min-w-0`}
                      value={field.options ?? ''}
                      placeholder="Low, Medium, High"
                      onChange={(event) => updateField(index, { options: event.target.value })}
                      data-testid={`new-type-field-options-${index}`}
                    />
                  ) : null}
                  {field.kind === 'relation' ? (
                    <select
                      className={`${controlClass} flex-1 min-w-0`}
                      value={field.targetTypeId ?? ''}
                      onChange={(event) => updateField(index, { targetTypeId: event.target.value || undefined })}
                      data-testid={`new-type-field-target-${index}`}
                    >
                      <option value="">Choose a type</option>
                      {types.map((type) => <option key={type.typeId} value={type.typeId}>{type.name}</option>)}
                    </select>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Remove field"
                    className="w-7 h-7 shrink-0 rounded-md inline-flex items-center justify-center text-nim-faint hover:text-nim hover:bg-nim-hover"
                    onClick={() => setFields((current) => current.filter((_, i) => i !== index))}
                  >
                    <MaterialSymbol icon="close" size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="new-type-add-field self-start inline-flex items-center gap-1 text-xs text-nim-muted hover:text-nim"
                onClick={() => setFields((current) => [...current, { label: '', kind: 'text' }])}
                data-testid="new-type-add-field"
              >
                <MaterialSymbol icon="add" size={14} />
                Add field
              </button>
            </div>
          </div>

          {syncingNotice ? (
            <div className="new-type-syncing text-xs text-nim-muted" role="status">{syncingNotice}</div>
          ) : null}
          {errors.length > 0 ? (
            <ul className="new-type-errors m-0 pl-4 text-xs text-[var(--nim-error)]" role="alert">
              {errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          ) : null}
        </div>

        <div className="px-4 py-2 border-t border-nim flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={running}
            className="px-3 py-1.5 rounded-md text-xs text-nim-muted hover:text-nim hover:bg-nim-hover disabled:opacity-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={running}
            className="new-type-create px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--nim-primary)] text-white disabled:opacity-50"
            onClick={() => { if (syncingNotice) onClose(); else void create(); }}
            data-testid="new-type-create"
          >
            {running ? 'Creating...' : syncingNotice ? 'Close' : 'Create type'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
