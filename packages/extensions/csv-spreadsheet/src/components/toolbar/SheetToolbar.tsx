/**
 * The compact sheet toolbar: history, number formats, text styles, colors,
 * borders, alignment, wrap, freeze, hide, filter, conditional formatting,
 * validation and insert-function.
 *
 * Every button is a metadata command through `FormatActions` (one undo step,
 * published to collab), except undo/redo, filter and insert-function, which
 * call the executor, the filter dropdown and the cell editor respectively.
 * Button state (bold on, wrap on, current format) is read from the active cell.
 */

import { useRef, type ReactNode } from 'react';
import type { CellAlignment, CellStyle, CellVerticalAlignment, ColumnFormat } from '../../types';
import type { SpreadsheetMetadata } from '../../hooks/useSpreadsheetMetadata';
import type { EditorCore } from '../../editor/editorCore';
import type { FormatActions } from '../../editor/useFormatActions';
import { useSelectionVersion } from '../../editor/useSelectionVersion';
import { CellStyleIndex } from '../../cells/cellStyles';
import { columnIndexToLetter } from '../../utils/csvParser';
import {
  adjustDecimals, applyBorders, effectiveFormat, freezeCols, freezeRows, hideCols, hideRows, isWrapped,
  presetFormat, setCellFormat, setStyle, setWrap, toggleStyle, unhideCols, unhideRows,
  type BorderPreset, type NumberFormatPreset, type ToggleStyle,
} from '../../format/formatActions';
import type { BorderLineStyle } from '../../sheetMeta/formatting';
import { ToolbarMenu, MenuItem, MenuSeparator } from './ToolbarMenu';
import { ColorPalette } from './ColorPalette';
import * as Icons from './toolbarIcons';

const NUMBER_PRESETS: readonly { preset: NumberFormatPreset; label: string; sample: string }[] = [
  { preset: 'automatic', label: 'Automatic', sample: '' },
  { preset: 'text', label: 'Plain text', sample: '' },
  { preset: 'number', label: 'Number', sample: '1,000.12' },
  { preset: 'percent', label: 'Percent', sample: '10.12%' },
  { preset: 'scientific', label: 'Scientific', sample: '1.01E+03' },
  { preset: 'accounting', label: 'Accounting', sample: '$ (1,000.12)' },
  { preset: 'currency', label: 'Currency', sample: '$1,000.12' },
  { preset: 'currencyRounded', label: 'Currency rounded', sample: '$1,000' },
  { preset: 'date', label: 'Date', sample: '9/26/2008' },
  { preset: 'time', label: 'Time', sample: '3:59 PM' },
  { preset: 'datetime', label: 'Date time', sample: '9/26/2008 15:59' },
];

const BORDER_PRESETS: readonly { preset: BorderPreset; label: string }[] = [
  { preset: 'all', label: 'All borders' },
  { preset: 'outer', label: 'Outer borders' },
  { preset: 'inner', label: 'Inner borders' },
  { preset: 'horizontal', label: 'Inner horizontal' },
  { preset: 'vertical', label: 'Inner vertical' },
  { preset: 'top', label: 'Top border' },
  { preset: 'bottom', label: 'Bottom border' },
  { preset: 'left', label: 'Left border' },
  { preset: 'right', label: 'Right border' },
  { preset: 'none', label: 'Clear borders' },
];
const BORDER_STYLES: readonly BorderLineStyle[] = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];

const FUNCTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF', 'VLOOKUP', 'CONCATENATE'] as const;

function presetOf(format: ColumnFormat | undefined, hasOwn: boolean): NumberFormatPreset | null {
  if (!format) return 'automatic';
  if (!hasOwn && format.type === 'text') return 'automatic';
  if (format.type === 'currency') {
    if (format.numberStyle === 'accounting') return 'accounting';
    return format.decimals === 0 ? 'currencyRounded' : 'currency';
  }
  if (format.type === 'number') return format.numberStyle === 'scientific' ? 'scientific' : 'number';
  if (format.type === 'percentage') return 'percent';
  if (format.type === 'text') return 'text';
  if (format.type === 'date' || format.type === 'time' || format.type === 'datetime') return format.type;
  return null;
}

export interface SheetToolbarProps {
  core: EditorCore;
  metadata: SpreadsheetMetadata;
  actions: FormatActions;
  disabled: boolean;
  onFilter: (columnIndex: number, anchor: HTMLElement) => void;
  onInsertFunction: (name: string) => void;
  onOpenConditional: () => void;
  onOpenValidation: () => void;
  onOpenNamedRanges: () => void;
  /** Right-aligned extras (View Source). */
  trailing?: ReactNode;
}

function Button({ title, name, on, disabled, onClick, children }: {
  title: string; name: string; on?: boolean; disabled?: boolean; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`sheet-toolbar-button ${on ? 'sheet-toolbar-button-on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      data-toolbar={name}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Separator = () => <span className="sheet-toolbar-separator" aria-hidden="true" />;

export function SheetToolbar(props: SheetToolbarProps) {
  const { core, metadata, actions, disabled } = props;
  useSelectionVersion(core);
  const borderStyleRef = useRef<BorderLineStyle>('thin');
  const selected = actions.target();
  const active = selected?.active ?? null;
  const range = selected?.range ?? null;
  const style: CellStyle = (active && new CellStyleIndex(metadata.cellStyles).styleAt(active.row, active.col)) || {};
  const meta = { ...metadata };
  const format = active ? effectiveFormat(meta, active) : undefined;
  const ownFormat = !!active && format !== metadata.columnFormats[active.col];
  const currentPreset = presetOf(format, ownFormat);
  const wrapped = !!active && isWrapped(meta, active);
  const off = disabled || !selected;

  const toggle = (name: ToggleStyle) => () => actions.apply((m, r, a) => toggleStyle(m, r, a, name));
  const styleButton = (name: ToggleStyle, title: string, label: ReactNode) => (
    <Button title={title} name={name} on={!!style[name]} disabled={off} onClick={toggle(name)}>{label}</Button>
  );
  const align = (value: CellAlignment) => actions.apply((m, r) => setStyle(m, r, { align: value }));
  const valign = (value: CellVerticalAlignment) => actions.apply((m, r) => setStyle(m, r, { verticalAlign: value }));
  const activeRow = active ? active.row + 1 : 1;
  const activeCol = active ? columnIndexToLetter(active.col) : 'A';

  return (
    <div className="sheet-toolbar" role="toolbar" aria-label="Sheet formatting">
      <Button title="Undo" name="undo" disabled={disabled} onClick={() => void core.gridOpsRef.current?.executor.undo()}><Icons.UndoIcon /></Button>
      <Button title="Redo" name="redo" disabled={disabled} onClick={() => void core.gridOpsRef.current?.executor.redo()}><Icons.RedoIcon /></Button>
      <Separator />
      <Button title="Format as currency" name="currency" on={currentPreset === 'currency'} disabled={off}
        onClick={() => actions.apply((m, r) => setCellFormat(m, r, presetFormat('currency')))}><span className="sheet-toolbar-text">$</span></Button>
      <Button title="Format as percent" name="percent" on={currentPreset === 'percent'} disabled={off}
        onClick={() => actions.apply((m, r) => setCellFormat(m, r, presetFormat('percent')))}><span className="sheet-toolbar-text">%</span></Button>
      <Button title="Decrease decimal places" name="decimals-less" disabled={off}
        onClick={() => actions.apply((m, r, a) => adjustDecimals(m, r, a, -1))}><span className="sheet-toolbar-small">.0</span><Icons.DecimalsLessIcon /></Button>
      <Button title="Increase decimal places" name="decimals-more" disabled={off}
        onClick={() => actions.apply((m, r, a) => adjustDecimals(m, r, a, 1))}><span className="sheet-toolbar-small">.00</span><Icons.DecimalsMoreIcon /></Button>
      <ToolbarMenu name="number-format" title="More formats" disabled={off} label={<span className="sheet-toolbar-small">123</span>}>
        {(close) => NUMBER_PRESETS.map(({ preset, label, sample }) => (
          <MenuItem key={preset} label={label} hint={sample} checked={currentPreset === preset}
            onSelect={() => { actions.apply((m, r) => setCellFormat(m, r, presetFormat(preset))); close(); }} />
        ))}
      </ToolbarMenu>
      <Separator />
      {styleButton('bold', 'Bold', <span className="sheet-toolbar-text font-extrabold">B</span>)}
      {styleButton('italic', 'Italic', <span className="sheet-toolbar-text italic font-serif">I</span>)}
      {styleButton('underline', 'Underline', <span className="sheet-toolbar-text underline">U</span>)}
      {styleButton('strikethrough', 'Strikethrough', <span className="sheet-toolbar-text line-through">S</span>)}
      <ToolbarMenu name="text-color" title="Text color" disabled={off}
        label={<span className="sheet-toolbar-stack"><span className="sheet-toolbar-text">A</span><ColorBar color={style.textColor} /></span>}>
        {(close) => <ColorPalette kind="text" value={style.textColor}
          onPick={(color) => { actions.apply((m, r) => setStyle(m, r, { textColor: color })); close(); }} />}
      </ToolbarMenu>
      <ToolbarMenu name="fill-color" title="Fill color" disabled={off}
        label={<span className="sheet-toolbar-stack"><Icons.FillIcon /><ColorBar color={style.fillColor} /></span>}>
        {(close) => <ColorPalette kind="fill" value={style.fillColor}
          onPick={(color) => { actions.apply((m, r) => setStyle(m, r, { fillColor: color })); close(); }} />}
      </ToolbarMenu>
      <Separator />
      <ToolbarMenu name="borders" title="Borders" disabled={off} label={<Icons.BordersIcon />}>
        {(close) => (
          <>
            {BORDER_PRESETS.map(({ preset, label }) => (
              <MenuItem key={preset} label={label} onSelect={() => {
                actions.apply((m, r) => applyBorders(m, r, preset, { style: borderStyleRef.current }));
                close();
              }} />
            ))}
            <MenuSeparator />
            <div className="sheet-toolbar-menu-row">
              <span className="sheet-toolbar-menu-hint">Line</span>
              <select className="sheet-toolbar-select" defaultValue={borderStyleRef.current} aria-label="Border line style"
                onChange={(event) => { borderStyleRef.current = event.target.value as BorderLineStyle; }}>
                {BORDER_STYLES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          </>
        )}
      </ToolbarMenu>
      <Separator />
      <ToolbarMenu name="align" title="Horizontal align" disabled={off}
        label={style.align === 'center' ? <Icons.AlignCenterIcon /> : style.align === 'right' ? <Icons.AlignRightIcon /> : <Icons.AlignLeftIcon />}>
        {(close) => (['left', 'center', 'right'] as const).map((value) => (
          <MenuItem key={value} label={value[0].toUpperCase() + value.slice(1)} checked={style.align === value}
            onSelect={() => { align(value); close(); }} />
        ))}
      </ToolbarMenu>
      <ToolbarMenu name="valign" title="Vertical align" disabled={off}
        label={style.verticalAlign === 'middle' ? <Icons.VAlignMiddleIcon /> : style.verticalAlign === 'bottom' ? <Icons.VAlignBottomIcon /> : <Icons.VAlignTopIcon />}>
        {(close) => (['top', 'middle', 'bottom'] as const).map((value) => (
          <MenuItem key={value} label={value[0].toUpperCase() + value.slice(1)} checked={style.verticalAlign === value}
            onSelect={() => { valign(value); close(); }} />
        ))}
      </ToolbarMenu>
      <Button title={wrapped ? 'Turn off text wrapping' : 'Wrap text'} name="wrap" on={wrapped} disabled={off}
        onClick={() => actions.apply((m, r) => setWrap(m, r, !wrapped))}><Icons.WrapIcon /></Button>
      <Separator />
      <ToolbarMenu name="freeze" title="Freeze" disabled={disabled} label={<Icons.FreezeIcon />}>
        {(close) => {
          const rows = metadata.headerRowCount + metadata.frozenRowCount;
          const run = (patch: Parameters<FormatActions['applyMeta']>[0]) => { actions.applyMeta(patch); close(); };
          return (
            <>
              <MenuItem label="No rows" checked={rows === 0} disabled={metadata.headerRowCount > 0}
                onSelect={() => run((m) => freezeRows(m, 0))} />
              <MenuItem label="1 row" checked={rows === 1} disabled={metadata.headerRowCount > 1} onSelect={() => run((m) => freezeRows(m, 1))} />
              <MenuItem label="2 rows" checked={rows === 2} disabled={metadata.headerRowCount > 2} onSelect={() => run((m) => freezeRows(m, 2))} />
              <MenuItem label={`Up to row ${activeRow}`} checked={rows === activeRow} disabled={!active || metadata.headerRowCount > activeRow}
                onSelect={() => run((m) => freezeRows(m, activeRow))} />
              <MenuSeparator />
              <MenuItem label="No columns" checked={metadata.frozenColumnCount === 0} onSelect={() => run((m) => freezeCols(m, 0))} />
              <MenuItem label="1 column" checked={metadata.frozenColumnCount === 1} onSelect={() => run((m) => freezeCols(m, 1))} />
              <MenuItem label="2 columns" checked={metadata.frozenColumnCount === 2} onSelect={() => run((m) => freezeCols(m, 2))} />
              <MenuItem label={`Up to column ${activeCol}`} checked={!!active && metadata.frozenColumnCount === active.col + 1} disabled={!active}
                onSelect={() => run((m) => freezeCols(m, (active?.col ?? 0) + 1))} />
            </>
          );
        }}
      </ToolbarMenu>
      <ToolbarMenu name="hide" title="Hide rows or columns" disabled={off} label={<Icons.HideIcon />}>
        {(close) => range && (
          <>
            <MenuItem label={range.startRow === range.endRow ? `Hide row ${range.startRow + 1}` : `Hide rows ${range.startRow + 1}-${range.endRow + 1}`}
              onSelect={() => { actions.apply((m, r) => hideRows(m, r.startRow, r.endRow)); close(); }} />
            <MenuItem label={range.startCol === range.endCol ? `Hide column ${columnIndexToLetter(range.startCol)}` : `Hide columns ${columnIndexToLetter(range.startCol)}-${columnIndexToLetter(range.endCol)}`}
              onSelect={() => { actions.apply((m, r) => hideCols(m, r.startCol, r.endCol)); close(); }} />
            <MenuSeparator />
            <MenuItem label="Unhide rows" disabled={metadata.hiddenRows.length === 0}
              onSelect={() => { actions.apply((m, r) => unhideRows(m, r.startRow, r.endRow)); close(); }} />
            <MenuItem label="Unhide columns" disabled={metadata.hiddenCols.length === 0}
              onSelect={() => { actions.apply((m, r) => unhideCols(m, r.startCol, r.endCol)); close(); }} />
          </>
        )}
      </ToolbarMenu>
      <Button title="Filter this column" name="filter" disabled={!active} onClick={(event) => {
        if (active) props.onFilter(active.col, event.currentTarget);
      }}><Icons.FilterIcon /></Button>
      <Button title="Conditional formatting" name="conditional" disabled={disabled} onClick={props.onOpenConditional}><Icons.ConditionalIcon /></Button>
      <Button title="Data validation" name="validation" disabled={off} onClick={props.onOpenValidation}><Icons.ValidationIcon /></Button>
      <Button title="Named ranges" name="named-ranges" disabled={disabled} onClick={props.onOpenNamedRanges}><Icons.NamedRangesIcon /></Button>
      <Separator />
      <ToolbarMenu name="function" title="Insert function" disabled={off} label={<span className="sheet-toolbar-sigma">&Sigma;</span>}>
        {(close) => FUNCTIONS.map((name) => (
          <MenuItem key={name} label={name} onSelect={() => { props.onInsertFunction(name); close(); }} />
        ))}
      </ToolbarMenu>
      <span className="sheet-toolbar-spacer" />
      {props.trailing}
    </div>
  );
}

function ColorBar({ color }: { color: CellStyle['textColor'] }) {
  if (!color || color === 'default') return <span className="sheet-toolbar-color-bar sheet-toolbar-color-bar-empty" />;
  if (color.startsWith('#')) return <span className="sheet-toolbar-color-bar" style={{ backgroundColor: color }} />;
  return <span className={`sheet-toolbar-color-bar csv-swatch csv-fill-${color}`} />;
}
