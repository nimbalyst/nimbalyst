import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  MaterialSymbol,
  globalRegistry,
  serializeTrackerYAML,
  type TrackerDataModel,
  type FieldDefinition,
  type FieldType,
} from '@nimbalyst/runtime';
import {
  loadLayout,
  saveLayout,
  loadLegacyState,
  buildLayoutFromLegacy,
  reconcileLayout,
  addFolder,
  assignTypeToFolder,
  type TrackerSidebarLayout,
} from '../../../services/TrackerSidebarLayout';

// ============================================================================
// Types
// ============================================================================

interface TrackerTypeCreatorProps {
  workspacePath: string;
  onClose: () => void;
  onCreated: () => void;
}

interface FieldRow {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  options: string;
  isLocked: boolean;
}

interface FormErrors {
  displayName?: string;
  typeId?: string;
  idPrefix?: string;
  fields?: string;
  submit?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ICON_OPTIONS = [
  'task_alt',
  'bug_report',
  'lightbulb',
  'code',
  'package',
  'description',
  'people',
  'groups',
  'campaign',
  'science',
  'flag',
  'build',
  'star',
  'bookmark',
  'label',
  'folder',
  'inbox',
  'event',
  'checklist',
  'inventory_2',
  'engineering',
  'psychology',
  'track_changes',
  'article',
  'menu_book',
];

const COLOR_PRESETS = [
  '#3b82f6',
  '#ef4444',
  '#22c55e',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#6b7280',
  '#14b8a6',
];

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'string', label: 'Text (short)' },
  { value: 'text', label: 'Text (long)' },
  { value: 'select', label: 'Select' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'multiselect', label: 'Multi-select' },
  { value: 'datetime', label: 'Date & Time' },
  { value: 'user', label: 'User' },
  { value: 'reference', label: 'Reference' },
];

const TYPE_ID_REGEX = /^[a-z][a-z0-9-_]*$/;
const ID_PREFIX_REGEX = /^[a-z][a-z0-9]{2,3}$/;

// ============================================================================
// Helpers
// ============================================================================

function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '');
}

function deriveIdPrefix(displayName: string): string {
  const letters = displayName
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return letters.slice(0, 4);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function buildDefaultFields(): FieldRow[] {
  return [
    {
      id: generateId(),
      name: 'title',
      type: 'string',
      required: true,
      options: '',
      isLocked: true,
    },
    {
      id: generateId(),
      name: 'status',
      type: 'select',
      required: false,
      options: 'Todo, In Progress, Done',
      isLocked: false,
    },
  ];
}

function parseOptions(raw: string): Array<{ value: string; label: string }> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label) => ({
      value: label.toLowerCase().replace(/\s+/g, '-'),
      label,
    }));
}

function buildFieldDefinition(row: FieldRow): FieldDefinition {
  const def: FieldDefinition = {
    name: row.name.trim(),
    type: row.type,
    required: row.required,
  };
  if ((row.type === 'select' || row.type === 'multiselect') && row.options.trim()) {
    def.options = parseOptions(row.options);
  }
  return def;
}

// ============================================================================
// Sub-components
// ============================================================================

function FormLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[12px] font-semibold text-[var(--nim-text-muted)] uppercase tracking-wide mb-1.5">
      {children}
    </label>
  );
}

function FormInput({
  value,
  onChange,
  placeholder,
  maxLength,
  className = '',
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className={`w-full px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors placeholder:text-[var(--nim-text-faint)] ${mono ? 'font-mono' : ''} ${className}`}
    />
  );
}

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[11px] text-[#ef4444] mt-1">{message}</p>;
}

function FieldRowEditor({
  row,
  onUpdate,
  onRemove,
}: {
  row: FieldRow;
  onUpdate: (updated: FieldRow) => void;
  onRemove: () => void;
}) {
  const showOptions = row.type === 'select' || row.type === 'multiselect';

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 bg-[var(--nim-bg)] rounded-md border border-[var(--nim-border)]">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={row.name}
          onChange={(e) => onUpdate({ ...row, name: e.target.value })}
          placeholder="field_name"
          disabled={row.isLocked}
          className={`flex-1 px-2 py-1 text-[12px] font-mono bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors placeholder:text-[var(--nim-text-faint)] ${row.isLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
        />
        <select
          value={row.type}
          onChange={(e) => onUpdate({ ...row, type: e.target.value as FieldType })}
          className="px-2 py-1 text-[12px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] cursor-pointer"
        >
          {FIELD_TYPES.map((ft) => (
            <option key={ft.value} value={ft.value}>
              {ft.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-[var(--nim-text-muted)] cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={row.required}
            onChange={(e) => onUpdate({ ...row, required: e.target.checked })}
            className="cursor-pointer"
          />
          Required
        </label>
        {row.isLocked ? (
          <div className="w-5 h-5 shrink-0 flex items-center justify-center">
            <MaterialSymbol icon="lock" size={12} className="text-[var(--nim-text-faint)]" />
          </div>
        ) : (
          <button
            onClick={onRemove}
            className="w-5 h-5 shrink-0 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[#ef4444] hover:bg-[var(--nim-bg-tertiary)] cursor-pointer transition-colors"
            title="Remove field"
          >
            <MaterialSymbol icon="close" size={12} />
          </button>
        )}
      </div>
      {showOptions && (
        <div className="pl-1">
          <input
            type="text"
            value={row.options}
            onChange={(e) => onUpdate({ ...row, options: e.target.value })}
            placeholder="Option 1, Option 2, Option 3"
            className="w-full px-2 py-1 text-[11px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors placeholder:text-[var(--nim-text-faint)]"
          />
          <p className="text-[10px] text-[var(--nim-text-faint)] mt-1">Comma-separated option labels</p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TrackerTypeCreator
// ============================================================================

export function TrackerTypeCreator({ workspacePath, onClose, onCreated }: TrackerTypeCreatorProps) {
  const [displayName, setDisplayName] = useState('');
  const [displayNamePlural, setDisplayNamePlural] = useState('');
  const [typeId, setTypeId] = useState('');
  const [typeIdManuallyEdited, setTypeIdManuallyEdited] = useState(false);
  const [idPrefix, setIdPrefix] = useState('');
  const [idPrefixManuallyEdited, setIdPrefixManuallyEdited] = useState(false);
  const [icon, setIcon] = useState('task_alt');
  const [color, setColor] = useState('#3b82f6');
  const [colorInput, setColorInput] = useState('#3b82f6');
  const [inlineMode, setInlineMode] = useState(true);
  const [fullDocMode, setFullDocMode] = useState(false);
  const [fields, setFields] = useState<FieldRow[]>(buildDefaultFields);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Folder state
  const [sidebarLayout, setSidebarLayout] = useState<TrackerSidebarLayout>({ entries: [] });
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      let saved = await loadLayout(workspacePath);
      if (saved.entries.length === 0) {
        const legacy = await loadLegacyState(workspacePath);
        const models = globalRegistry.getAll();
        saved = buildLayoutFromLegacy(models, legacy.folders, legacy.overrides);
      }
      setSidebarLayout(saved);
    })();
  }, [workspacePath]);

  // Sync color input with color state when swatch is clicked
  useEffect(() => {
    setColorInput(color);
  }, [color]);

  // Auto-derive typeId from displayName when not manually edited
  useEffect(() => {
    if (!typeIdManuallyEdited) {
      setTypeId(toKebabCase(displayName));
    }
  }, [displayName, typeIdManuallyEdited]);

  // Auto-derive idPrefix from displayName when not manually edited
  useEffect(() => {
    if (!idPrefixManuallyEdited) {
      setIdPrefix(deriveIdPrefix(displayName));
    }
  }, [displayName, idPrefixManuallyEdited]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }, [onClose]);

  const handleDisplayNameChange = useCallback((val: string) => {
    setDisplayName(val);
    if (!typeIdManuallyEdited) {
      setTypeId(toKebabCase(val));
    }
    if (!idPrefixManuallyEdited) {
      setIdPrefix(deriveIdPrefix(val));
    }
    setErrors((prev) => ({ ...prev, displayName: undefined }));
  }, [typeIdManuallyEdited, idPrefixManuallyEdited]);

  const handleTypeIdChange = useCallback((val: string) => {
    const normalized = val.toLowerCase();
    setTypeId(normalized);
    setTypeIdManuallyEdited(true);
    setErrors((prev) => ({ ...prev, typeId: undefined }));
  }, []);

  const handleIdPrefixChange = useCallback((val: string) => {
    const normalized = val.toLowerCase().replace(/[^a-z0-9]/g, '');
    setIdPrefix(normalized);
    setIdPrefixManuallyEdited(true);
    setErrors((prev) => ({ ...prev, idPrefix: undefined }));
  }, []);

  const handleColorInputChange = useCallback((val: string) => {
    setColorInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      setColor(val);
    }
  }, []);

  const handleColorInputBlur = useCallback(() => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorInput)) {
      setColor(colorInput);
    } else {
      setColorInput(color);
    }
  }, [colorInput, color]);

  const addField = useCallback(() => {
    setFields((prev) => [
      ...prev,
      {
        id: generateId(),
        name: '',
        type: 'string',
        required: false,
        options: '',
        isLocked: false,
      },
    ]);
    setErrors((prev) => ({ ...prev, fields: undefined }));
  }, []);

  const updateField = useCallback((id: string, updated: FieldRow) => {
    setFields((prev) => prev.map((f) => (f.id === id ? updated : f)));
  }, []);

  const removeField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const validate = useCallback((): FormErrors => {
    const errs: FormErrors = {};

    if (!displayName.trim()) {
      errs.displayName = 'Display name is required.';
    }

    if (!typeId) {
      errs.typeId = 'Type ID is required.';
    } else if (!TYPE_ID_REGEX.test(typeId)) {
      errs.typeId = 'Must start with a letter and contain only lowercase letters, digits, hyphens, or underscores.';
    } else {
      const existing = globalRegistry.getAll().map((m) => m.type);
      if (existing.includes(typeId)) {
        errs.typeId = `A tracker type with ID "${typeId}" already exists.`;
      }
    }

    if (!idPrefix) {
      errs.idPrefix = 'ID prefix is required.';
    } else if (!ID_PREFIX_REGEX.test(idPrefix)) {
      errs.idPrefix = 'Must be 3-4 lowercase alphanumeric characters with no leading digit.';
    }

    const validFields = fields.filter((f) => f.name.trim());
    if (validFields.length === 0) {
      errs.fields = 'At least one field with a name is required.';
    }

    return errs;
  }, [displayName, typeId, idPrefix, fields]);

  const handleCreate = useCallback(async () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      const resolvedGroup: string | undefined = isCreatingFolder && newFolderName.trim()
        ? newFolderName.trim()
        : selectedFolder || undefined;

      const fieldDefs: FieldDefinition[] = fields
        .filter((f) => f.name.trim())
        .map(buildFieldDefinition);

      const model: TrackerDataModel = {
        type: typeId,
        displayName: displayName.trim(),
        displayNamePlural: (displayNamePlural.trim() || `${displayName.trim()}s`),
        icon,
        color,
        modes: {
          inline: inlineMode,
          fullDocument: fullDocMode,
        },
        idPrefix,
        idFormat: 'ulid',
        fields: fieldDefs,
        ...(resolvedGroup ? { group: resolvedGroup } : {}),
      };

      const yamlContent = serializeTrackerYAML(model);
      const filePath = `${workspacePath}/.nimbalyst/trackers/${model.type}.yaml`;

      const result = await (window as any).electronAPI.createFile(filePath, yamlContent);
      if (result && result.success === false) {
        setErrors({ submit: result.error ?? 'Failed to create tracker file.' });
        setIsSubmitting(false);
        return;
      }

      globalRegistry.register(model);

      // Update layout: ensure folder exists (if new), then move type into it
      if (resolvedGroup) {
        let currentLayout = await loadLayout(workspacePath);
        if (currentLayout.entries.length === 0) {
          const legacy = await loadLegacyState(workspacePath);
          currentLayout = buildLayoutFromLegacy(
            globalRegistry.getAll(),
            legacy.folders,
            legacy.overrides
          );
        }
        const withFolder = isCreatingFolder
          ? addFolder(currentLayout, resolvedGroup)
          : currentLayout;
        const reconciled = reconcileLayout(withFolder, globalRegistry.getAll());
        const withAssignment = assignTypeToFolder(reconciled, typeId, resolvedGroup);
        await saveLayout(workspacePath, withAssignment);
      }

      onCreated();
      onClose();
    } catch (err) {
      setErrors({ submit: err instanceof Error ? err.message : 'An unexpected error occurred.' });
      setIsSubmitting(false);
    }
  }, [
    validate,
    fields,
    typeId,
    displayName,
    displayNamePlural,
    icon,
    color,
    inlineMode,
    fullDocMode,
    idPrefix,
    workspacePath,
    onCreated,
    onClose,
    selectedFolder,
    isCreatingFolder,
    newFolderName,
  ]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      tabIndex={-1}
    >
      <div
        className="relative flex flex-col bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl w-full max-w-[560px] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--nim-border)] shrink-0">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--nim-text)]">Create Custom Tracker Type</h2>
            <p className="text-[12px] text-[var(--nim-text-muted)] mt-0.5">Define a new tracker type for your workspace.</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-secondary)] cursor-pointer transition-colors"
          >
            <MaterialSymbol icon="close" size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Display Name + Type ID */}
          <div>
            <FormLabel>Display Name</FormLabel>
            <FormInput
              value={displayName}
              onChange={handleDisplayNameChange}
              placeholder="e.g. Bug Report"
            />
            <InlineError message={errors.displayName} />
            {typeId && (
              <p className="text-[11px] text-[var(--nim-text-faint)] mt-1">
                Type ID: <span className="font-mono">{typeId}</span>
              </p>
            )}
          </div>

          {/* Display Name Plural */}
          <div>
            <FormLabel>Display Name (Plural)</FormLabel>
            <FormInput
              value={displayNamePlural}
              onChange={setDisplayNamePlural}
              placeholder={displayName ? `e.g. ${displayName}s` : 'e.g. Bug Reports'}
            />
          </div>

          {/* Type ID */}
          <div>
            <FormLabel>Type ID</FormLabel>
            <FormInput
              value={typeId}
              onChange={handleTypeIdChange}
              placeholder="e.g. bug-report"
              mono
            />
            <InlineError message={errors.typeId} />
            <p className="text-[10px] text-[var(--nim-text-faint)] mt-1">
              Lowercase letters, digits, hyphens, underscores. Cannot be changed later.
            </p>
          </div>

          {/* ID Prefix */}
          <div>
            <FormLabel>ID Prefix</FormLabel>
            <div className="flex items-center gap-2">
              <div className="w-28">
                <FormInput
                  value={idPrefix}
                  onChange={handleIdPrefixChange}
                  placeholder="e.g. bugr"
                  maxLength={4}
                  mono
                />
              </div>
              <span className="text-[13px] text-[var(--nim-text-faint)] font-mono">-01J...</span>
            </div>
            <InlineError message={errors.idPrefix} />
            <p className="text-[10px] text-[var(--nim-text-faint)] mt-1">
              3-4 lowercase alphanumeric characters, no leading digit.
            </p>
          </div>

          {/* Icon */}
          <div>
            <FormLabel>Icon</FormLabel>
            <div className="flex items-center gap-2 mb-2">
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                style={{ background: `${color}20` }}
              >
                <MaterialSymbol icon={icon} size={18} style={{ color }} fill />
              </div>
              <FormInput
                value={icon}
                onChange={setIcon}
                placeholder="Material Symbol name"
              />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(32px,1fr))] gap-1">
              {ICON_OPTIONS.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  title={ic}
                  className={`w-8 h-8 flex items-center justify-center rounded-md cursor-pointer transition-colors ${
                    icon === ic
                      ? 'bg-[var(--nim-primary)] text-white'
                      : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]'
                  }`}
                >
                  <MaterialSymbol icon={ic} size={16} />
                </button>
              ))}
            </div>
          </div>

          {/* Color */}
          <div>
            <FormLabel>Color</FormLabel>
            <div className="flex items-center gap-2 mb-2">
              <div
                className="w-7 h-7 rounded-md border border-[var(--nim-border)] shrink-0"
                style={{ background: color }}
              />
              <input
                type="text"
                value={colorInput}
                onChange={(e) => handleColorInputChange(e.target.value)}
                onBlur={handleColorInputBlur}
                placeholder="#3b82f6"
                maxLength={7}
                className="w-28 px-2.5 py-1.5 text-[13px] font-mono bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors placeholder:text-[var(--nim-text-faint)]"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setColor(preset)}
                  title={preset}
                  className={`w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110 ${
                    color === preset ? 'ring-2 ring-offset-1 ring-[var(--nim-primary)] ring-offset-[var(--nim-bg)]' : ''
                  }`}
                  style={{ background: preset }}
                />
              ))}
            </div>
          </div>

          {/* Modes */}
          <div>
            <FormLabel>Modes</FormLabel>
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={inlineMode}
                  onChange={(e) => setInlineMode(e.target.checked)}
                  className="mt-0.5 cursor-pointer"
                />
                <div>
                  <div className="text-[13px] text-[var(--nim-text)]">Inline mode</div>
                  <div className="text-[11px] text-[var(--nim-text-faint)]">Use in markdown documents (e.g. <code className="text-[10px] bg-[var(--nim-bg-secondary)] px-1 rounded">#type[...]</code>)</div>
                </div>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fullDocMode}
                  onChange={(e) => setFullDocMode(e.target.checked)}
                  className="mt-0.5 cursor-pointer"
                />
                <div>
                  <div className="text-[13px] text-[var(--nim-text)]">Full document mode</div>
                  <div className="text-[11px] text-[var(--nim-text-faint)]">Items get their own dedicated pages</div>
                </div>
              </label>
            </div>
          </div>

          {/* Folder */}
          <div>
            <FormLabel>Folder</FormLabel>
            <select
              value={isCreatingFolder ? '__new__' : selectedFolder}
              onChange={(e) => {
                if (e.target.value === '__new__') {
                  setIsCreatingFolder(true);
                  setSelectedFolder('');
                } else {
                  setIsCreatingFolder(false);
                  setSelectedFolder(e.target.value);
                }
              }}
              className="w-full px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] cursor-pointer transition-colors"
            >
              <option value="">(no folder)</option>
              {sidebarLayout.entries
                .filter((e): e is Extract<typeof e, { kind: 'folder' }> => e.kind === 'folder')
                .map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              <option value="__new__">Create new folder…</option>
            </select>
            {isCreatingFolder && (
              <div className="mt-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="New folder name"
                  autoFocus
                  className="w-full px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded-md text-[var(--nim-text)] outline-none transition-colors placeholder:text-[var(--nim-text-faint)]"
                />
                <p className="text-[10px] text-[var(--nim-text-faint)] mt-1">
                  The folder will be created when you click "Create Tracker".
                </p>
              </div>
            )}
          </div>

          {/* Fields */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <FormLabel>Fields</FormLabel>
              <button
                onClick={addField}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] hover:bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded cursor-pointer transition-colors"
              >
                <MaterialSymbol icon="add" size={12} />
                Add field
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {fields.map((row) => (
                <FieldRowEditor
                  key={row.id}
                  row={row}
                  onUpdate={(updated) => updateField(row.id, updated)}
                  onRemove={() => removeField(row.id)}
                />
              ))}
            </div>
            <InlineError message={errors.fields} />
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-[var(--nim-border)] shrink-0 bg-[var(--nim-bg)]">
          <div className="flex-1">
            {errors.submit && (
              <p className="text-[11px] text-[#ef4444]">{errors.submit}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3.5 py-1.5 text-[13px] font-medium text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] bg-transparent hover:bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={isSubmitting}
              className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-[var(--nim-primary)] hover:opacity-90 rounded-md cursor-pointer transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Creating…' : 'Create Tracker'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
