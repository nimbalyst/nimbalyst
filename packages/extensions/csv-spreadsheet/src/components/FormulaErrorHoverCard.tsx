/**
 * Hover card that explains an error value (`#REF!`, `#NAME?`, `#DIV/0!`, ...)
 * when the pointer rests on a cell showing one. The explanation names the
 * cause when the cell's formula makes it obvious (`describeFormulaError`).
 *
 * Hover is read by delegation off the grid container, so the cell templates
 * stay untouched; the card never takes pointer events.
 */

import { useEffect, useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import type { EditorCore } from '../editor/editorCore';
import { logicalCellOfElement } from '../editor/useFormulaPointMode';
import { asFormulaErrorCode, describeFormulaError, type FormulaErrorDescription } from '../formula/formulaErrors';

const HOVER_DELAY_MS = 350;

export function FormulaErrorHoverCard({ core, enabled }: { core: EditorCore; enabled: boolean }) {
  const [shown, setShown] = useState<{ cell: Element; description: FormulaErrorDescription } | null>(null);

  useEffect(() => {
    const container = core.gridContainerRef.current;
    if (!enabled || !container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hovered: Element | null = null;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      hovered = null;
      setShown(null);
    };

    const onOver = (event: MouseEvent) => {
      const cell = (event.target as Element | null)?.closest?.('[data-rgrow][data-rgcol]') ?? null;
      if (cell === hovered) return;
      clear();
      if (!cell || event.buttons !== 0) return;
      const code = asFormulaErrorCode(cell.textContent);
      const position = code ? logicalCellOfElement(cell, core) : null;
      if (!code || !position) return;
      hovered = cell;
      timer = setTimeout(async () => {
        const formula = await core.gridOpsRef.current?.getCellRawValue(position.row, position.col).catch(() => undefined);
        if (hovered !== cell || !cell.isConnected) return;
        setShown({ cell, description: describeFormulaError(code, formula) });
      }, HOVER_DELAY_MS);
    };

    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseleave', clear);
    container.addEventListener('pointerdown', clear, true);
    container.addEventListener('scroll', clear, true);
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseleave', clear);
      container.removeEventListener('pointerdown', clear, true);
      container.removeEventListener('scroll', clear, true);
      if (timer) clearTimeout(timer);
    };
  }, [core, enabled]);

  const { refs, floatingStyles } = useFloating({
    elements: { reference: shown?.cell ?? null },
    open: !!shown,
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  if (!shown) return null;
  const { code, title, detail } = shown.description;
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        role="tooltip"
        className="csv-formula-error-card z-50 w-64 px-2.5 py-2 pointer-events-none bg-nim-secondary border border-nim rounded-md shadow-lg text-[12px] text-nim"
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-semibold text-[var(--nim-error)]">{code}</span>
          <span className="font-semibold">{title}</span>
        </div>
        <div className="mt-1 text-[11.5px] text-nim-muted leading-snug">{detail}</div>
      </div>
    </FloatingPortal>
  );
}
