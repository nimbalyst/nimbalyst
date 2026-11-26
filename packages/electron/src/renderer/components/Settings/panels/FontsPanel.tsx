import React, { useEffect, useState } from 'react';
import { useSettingState } from '../../../hooks/useSetting';
import { useInstalledFonts } from '../../../hooks/useInstalledFonts';
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  toFontFamilyCss,
} from '../../../utils/fontSettings';

const INPUT_CLASS =
  'w-full py-2 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]';

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

interface FamilyFieldProps {
  id: string;
  label: string;
  description: string;
  value: string;
  fallback: string;
  families: string[];
  onFocusLoad: () => void;
  onCommit: (value: string) => void;
}

const FamilyField: React.FC<FamilyFieldProps> = ({
  id,
  label,
  description,
  value,
  fallback,
  families,
  onFocusLoad,
  onCommit,
}) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <label className="fonts-panel-field block mb-4">
      <span className="block text-sm font-medium text-[var(--nim-text)]">{label}</span>
      <span className="block text-xs text-[var(--nim-text-muted)] mb-2">{description}</span>
      <input
        type="text"
        className={INPUT_CLASS}
        list={`${id}-families`}
        value={draft}
        placeholder="Default"
        spellCheck={false}
        onFocus={onFocusLoad}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <datalist id={`${id}-families`}>
        {families.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <span
        className="fonts-panel-preview block mt-2 text-sm text-[var(--nim-text-muted)]"
        style={{ fontFamily: toFontFamilyCss(draft, fallback) }}
      >
        The quick brown fox jumps over the lazy dog 0123456789 {'{}'} ()
      </span>
    </label>
  );
};

interface SizeFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

const SizeField: React.FC<SizeFieldProps> = ({ label, value, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="fonts-panel-field block mb-4">
      <span className="block text-sm font-medium text-[var(--nim-text)] mb-2">{label}</span>
      <input
        type="number"
        className={`${INPUT_CLASS} w-24`}
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
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
  const [editorSize, setEditorSize] = useSettingState('appearance.editorFontSize');
  const [terminalSize, setTerminalSize] = useSettingState('appearance.terminalFontSize');
  const { families, load } = useInstalledFonts();

  const resetAll = () => {
    void setUiFamily('');
    void setCodeFamily('');
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
        id="fonts-ui"
        fallback={DEFAULT_UI_FONT_STACK}
        families={families}
        onFocusLoad={load}
        label="Interface font"
        description="Menus, sidebars, chat and documents."
        value={uiFamily}
        onCommit={(value) => void setUiFamily(value)}
      />
      <FamilyField
        id="fonts-code"
        fallback={DEFAULT_CODE_FONT_STACK}
        families={families}
        onFocusLoad={load}
        label="Code font"
        description="Code editors, diffs and the terminal."
        value={codeFamily}
        onCommit={(value) => void setCodeFamily(value)}
      />
      <SizeField label="Code editor size (px)" value={editorSize} onCommit={(value) => void setEditorSize(value)} />
      <SizeField label="Terminal size (px)" value={terminalSize} onCommit={(value) => void setTerminalSize(value)} />

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
