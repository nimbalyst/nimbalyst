/**
 * Full color palette for text and fill: the theme swatches first (they adapt
 * between light and dark), then a grid of exact colors, then a custom hex
 * field. Picking writes the value as-is into the cell style.
 */

import { useState } from 'react';
import type { CellColor, HexColor } from '../../types';

const THEME_SWATCHES: readonly Exclude<CellColor, 'default'>[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

/** Ten hues across, light to dark down, the layout people know from other sheets. */
export const PALETTE_ROWS: readonly (readonly HexColor[])[] = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

export function normalizeHex(text: string): HexColor | null {
  const trimmed = text.trim().replace(/^#?/, '#');
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase() as HexColor;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase() as HexColor;
  }
  return null;
}

export function ColorPalette({ value, onPick, kind }: {
  value: CellColor | HexColor | undefined;
  onPick: (color: CellColor | HexColor) => void;
  kind: 'text' | 'fill';
}) {
  const [custom, setCustom] = useState(value?.startsWith('#') ? value : '');
  const customHex = normalizeHex(custom);

  return (
    <div className="sheet-color-palette" data-palette={kind}>
      <button type="button" className="sheet-color-reset" onClick={() => onPick('default')}>Reset</button>
      <div className="sheet-color-row">
        {THEME_SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            title={`Theme ${color}`}
            aria-label={`Theme ${color}`}
            className={`sheet-color-swatch csv-swatch ${kind === 'text' ? `csv-text-swatch-${color}` : `csv-fill-${color}`} ${value === color ? 'sheet-color-swatch-on' : ''}`}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
      {PALETTE_ROWS.map((row) => (
        <div key={row[0]} className="sheet-color-row">
          {row.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={hex}
              className={`sheet-color-swatch ${value === hex ? 'sheet-color-swatch-on' : ''}`}
              style={{ backgroundColor: hex }}
              onClick={() => onPick(hex)}
            />
          ))}
        </div>
      ))}
      <form
        className="sheet-color-custom"
        onSubmit={(event) => {
          event.preventDefault();
          if (customHex) onPick(customHex);
        }}
      >
        <span className="sheet-color-swatch" style={{ backgroundColor: customHex ?? 'transparent' }} />
        <input
          className="sheet-color-input"
          value={custom}
          placeholder="#1a73e8"
          aria-label="Custom color"
          onChange={(event) => setCustom(event.target.value)}
        />
        <button type="submit" className="sheet-color-apply" disabled={!customHex}>Apply</button>
      </form>
    </div>
  );
}
