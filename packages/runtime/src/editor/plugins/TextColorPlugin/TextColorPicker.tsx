/**
 * Named-swatch picker for colored text: the 7 palette colors for text and the
 * same 7 for background, each with a "none" swatch that removes that kind.
 * Writes TextColorNode wrappers through `textColorActions.ts`, so the result
 * is an Obsidian-compatible `<span style="...">` in markdown.
 *
 * Used by the fixed toolbar and the floating selection toolbar.
 */

import type { JSX } from 'react';
import type { LexicalEditor } from 'lexical';

import DropDown, { DropDownItem } from '../../ui/DropDown';
import { $getSelectionTextColor, $setSelectionTextColor } from './textColorActions';
import {
  TEXT_COLOR_PALETTE,
  textColorCssVariable,
  type TextColorKind,
  type TextColorStyle,
} from '../../../core/textColorSyntax';
import './TextColorPicker.css';

const KINDS: Array<{ kind: TextColorKind; label: string }> = [
  { kind: 'color', label: 'Text' },
  { kind: 'background', label: 'Background' },
];

export function TextColorPicker({
  editor,
  disabled = false,
  buttonClassName,
}: {
  editor: LexicalEditor;
  disabled?: boolean;
  buttonClassName: string;
}): JSX.Element {
  const apply = (kind: TextColorKind, value: string | null) => {
    editor.update(() => {
      $setSelectionTextColor(kind, value);
    });
  };

  return (
    <DropDown
      disabled={disabled}
      buttonClassName={`${buttonClassName} text-color-picker-button`}
      buttonIconClassName="icon font-color"
      buttonAriaLabel="Text color"
      className="text-color-picker">
      <TextColorSwatches editor={editor} onPick={apply} />
    </DropDown>
  );
}

function TextColorSwatches({
  editor,
  onPick,
}: {
  editor: LexicalEditor;
  onPick: (kind: TextColorKind, value: string | null) => void;
}): JSX.Element {
  // Read once when the menu opens; the selection does not change while it is open.
  const current: TextColorStyle = editor.getEditorState().read(() => $getSelectionTextColor());
  const currentValue = (kind: TextColorKind) =>
    (kind === 'color' ? current.color : current.backgroundColor)?.toLowerCase() ?? null;

  return (
    <>
      {KINDS.map(({ kind, label }) => (
        <div key={kind} className="text-color-picker-section" data-kind={kind}>
          <div className="text-color-picker-label">{label}</div>
          <div className="text-color-picker-row">
            <DropDownItem
              className={`text-color-swatch text-color-swatch--none${currentValue(kind) === null ? ' active' : ''}`}
              title={kind === 'color' ? 'Default text color' : 'No background'}
              onClick={() => onPick(kind, null)}>
              <span className="text-color-swatch-chip">A</span>
            </DropDownItem>
            {TEXT_COLOR_PALETTE.map((swatch) => {
              const value = kind === 'color' ? swatch.color : swatch.background;
              const cssVar = `var(${textColorCssVariable(swatch.name, kind)}, ${value})`;
              return (
                <DropDownItem
                  key={swatch.name}
                  className={`text-color-swatch${currentValue(kind) === value ? ' active' : ''}`}
                  title={kind === 'color' ? `${swatch.label} text` : `${swatch.label} background`}
                  onClick={() => onPick(kind, value)}>
                  <span
                    className="text-color-swatch-chip"
                    style={kind === 'color' ? { color: cssVar } : { backgroundColor: cssVar }}>
                    A
                  </span>
                </DropDownItem>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
