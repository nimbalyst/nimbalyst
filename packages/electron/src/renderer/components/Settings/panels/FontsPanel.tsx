import React, { useEffect, useMemo, useState } from 'react';
import { useSettingState } from '../../../hooks/useSetting';
import { useInstalledFonts } from '../../../hooks/useInstalledFonts';
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  toFontFamilyCss,
} from '../../../utils/fontSettings';

const INPUT_CLASS =
  'w-full py-2 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]';

interface FamilyFieldProps {
  label: string;
  description: string;
  value: string;
  fallback: string;
  families: string[];
  onFocusLoad: () => void;
  onCommit: (value: string) => void;
}

const FamilyField: React.FC<FamilyFieldProps> = ({
  label,
  description,
  value,
  fallback,
  families,
  onFocusLoad,
  onCommit,
}) => {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const matches = useMemo(() => {
    const query = draft.trim().toLowerCase();
    return query === '' ? families : families.filter((family) => family.toLowerCase().includes(query));
  }, [draft, families]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  const choose = (family: string) => {
    setDraft(family);
    onCommit(family);
    setOpen(false);
  };

  return (
    <div className="fonts-panel-field mb-4">
      <span className="block text-sm font-medium text-[var(--nim-text)]">{label}</span>
      <span className="block text-xs text-[var(--nim-text-muted)] mb-2">{description}</span>
      <input
        type="text"
        className={INPUT_CLASS}
        value={draft}
        placeholder="Default"
        spellCheck={false}
        aria-label={label}
        onFocus={() => {
          onFocusLoad();
          setOpen(true);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          commit();
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <ul
          role="listbox"
          aria-label={`${label} suggestions`}
          className="fonts-panel-list mt-1 mb-0 p-1 max-h-56 overflow-y-auto list-none rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]"
        >
          {matches.map((family) => (
            <li
              key={family}
              role="option"
              aria-selected={family === value}
              className="fonts-panel-option py-1 px-2 rounded text-sm cursor-pointer text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
              // mousedown, not click: the input's blur would otherwise close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(family);
              }}
            >
              {family}
            </li>
          ))}
        </ul>
      )}
      <span
        className="fonts-panel-preview block mt-2 text-sm text-[var(--nim-text-muted)]"
        style={{ fontFamily: toFontFamilyCss(draft, fallback) }}
      >
        The quick brown fox jumps over the lazy dog 0123456789 {'{}'} ()
      </span>
    </div>
  );
};

interface SizeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}

const SizeField: React.FC<SizeFieldProps> = ({ label, value, min, max, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="fonts-panel-field block mb-4">
      <span className="block text-sm font-medium text-[var(--nim-text)] mb-2">{label}</span>
      <input
        type="number"
        className={`${INPUT_CLASS} w-24`}
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
};

export const FontsPanel: React.FC = () => {
  const [uiFamily, setUiFamily] = useSettingState('appearance.uiFontFamily');
  const [codeFamily, setCodeFamily] = useSettingState('appearance.codeFontFamily');
  const [uiScale, setUiScale] = useSettingState('appearance.uiScale');
  const [editorSize, setEditorSize] = useSettingState('appearance.editorFontSize');
  const [terminalSize, setTerminalSize] = useSettingState('appearance.terminalFontSize');
  const { families, load } = useInstalledFonts();

  const resetAll = () => {
    void setUiFamily('');
    void setCodeFamily('');
    void setUiScale(100);
    void setEditorSize(14);
    void setTerminalSize(13);
  };

  return (
    <div className="fonts-panel">
      <h3 className="text-lg font-semibold text-[var(--nim-text)] mb-1">Fonts</h3>
      <p className="text-sm text-[var(--nim-text-muted)] mb-4">
        Pick an installed font from the list or type a name or a list such as "Fira Code", monospace. Leave a field empty for the default.
      </p>

      <FamilyField
        fallback={DEFAULT_UI_FONT_STACK}
        families={families}
        onFocusLoad={load}
        label="Interface font"
        description="Menus, sidebars, chat and documents."
        value={uiFamily}
        onCommit={(value) => void setUiFamily(value)}
      />
      <SizeField
        label="Interface zoom (%)"
        min={50}
        max={300}
        value={uiScale}
        onCommit={(value) => void setUiScale(value)}
      />
      <FamilyField
        fallback={DEFAULT_CODE_FONT_STACK}
        families={families}
        onFocusLoad={load}
        label="Code font"
        description="Code editors, diffs and the terminal."
        value={codeFamily}
        onCommit={(value) => void setCodeFamily(value)}
      />
      <SizeField
        label="Code editor size (px)"
        min={8}
        max={32}
        value={editorSize}
        onCommit={(value) => void setEditorSize(value)}
      />
      <SizeField
        label="Terminal size (px)"
        min={8}
        max={32}
        value={terminalSize}
        onCommit={(value) => void setTerminalSize(value)}
      />

      <button
        type="button"
        className="fonts-panel-reset py-1.5 px-3 rounded-md text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
        onClick={resetAll}
      >
        Reset to defaults
      </button>
    </div>
  );
};
