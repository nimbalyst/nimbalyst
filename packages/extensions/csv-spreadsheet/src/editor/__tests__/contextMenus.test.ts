// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGridOperations } from '../../utils/gridOperations';
import { parseCSV } from '../../utils/csvParser';
import { createFakeGrid, createMetaStore, gridColumn } from '../../commands/__tests__/fakeGrid';
import { buildCellMenuItems, buildRowHeaderMenuItems, type ContextMenuDeps } from '../contextMenus';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(async () => undefined) }));

/** Real grid operations over a fake grid with synchronous metadata. */
function sheet(csv: string) {
  const { grid, parsed } = createFakeGrid(csv);
  const meta = createMetaStore(parsed);
  const gridOps = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',' });
  const deps: ContextMenuDeps = {
    gridOps,
    meta: { setSortConfig: vi.fn() },
    headerRowCount: parsed.data.headerRowCount,
    updateSelection: vi.fn(),
    openCellFormat: vi.fn(),
    openColumnFormat: vi.fn(),
    applyCellStyle: vi.fn(),
    applyDetectedColumnType: vi.fn(),
  };
  return { grid, gridOps, deps, header: () => meta.getMeta().headerRowCount };
}

async function run(items: { label: string; action: () => unknown }[], label: string) {
  const item = items.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`missing menu item ${label}`);
  item.action();
  // Let the command's reads and writes settle.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const HEADED = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}\nName\nAlice\nBob';

describe('header-row insert and delete', () => {
  // R1-1: the delete read the header count after the menu had already
  // decremented it, so deleting the header row deleted Alice instead.
  it('deleting the header row deletes the header, not the first body row', async () => {
    const { grid, gridOps, deps, header } = sheet(HEADED);
    await run(buildRowHeaderMenuItems(0, deps), 'Delete Row');
    expect(gridColumn(grid)).toEqual(['Alice', 'Bob']);
    expect(header()).toBe(0);
    // Without the line a reload would detect Alice as a header again.
    const saved = await gridOps.toCSV();
    expect(saved.split('\n').slice(1)).toEqual(['Alice', 'Bob']);
    expect(parseCSV(saved).data.headerRowCount).toBe(0);
  });

  it.each([
    ['cell menu', (d: ContextMenuDeps) => buildCellMenuItems({ row: 0, col: 0 }, null, d)],
    ['row-header menu', (d: ContextMenuDeps) => buildRowHeaderMenuItems(0, d)],
  ])('%s grows the header when inserting inside it, not below it', async (_name, build) => {
    const above = sheet(HEADED);
    await run(build(above.deps), 'Insert Row Above');
    expect(above.header()).toBe(2);
    expect([...above.grid.pinnedTopSource.map((row) => row.A)]).toEqual(['', 'Name']);

    const below = sheet(HEADED);
    await run(build(below.deps), 'Insert Row Below');
    expect(below.header()).toBe(1);
    expect(gridColumn(below.grid)).toEqual(['Name', 'Alice', 'Bob']);
  });
});

describe('hide and unhide from header menus', () => {
  it('hides the selected rows the clicked header is in, saves them, and unhides them in one undoable step each', async () => {
    const { gridOps, deps } = sheet(`${HEADED}\nCara\nDan`);
    deps.selectionRange = { startRow: 2, endRow: 3, startCol: 0, endCol: 0 };
    await run(buildRowHeaderMenuItems(3, deps), 'Hide Rows 3-4');
    expect(await gridOps.toCSV()).toContain('"hiddenRows":[2,3]');

    deps.hiddenRows = [2, 3];
    deps.selectionRange = null;
    await run(buildRowHeaderMenuItems(1, deps), 'Unhide Rows');
    expect(await gridOps.toCSV()).not.toContain('hiddenRows');
    await gridOps.executor.undo();
    expect(await gridOps.toCSV()).toContain('"hiddenRows":[2,3]');
  });

  it('never hides the header row, which is pinned', async () => {
    const { gridOps, deps } = sheet(HEADED);
    await run(buildRowHeaderMenuItems(0, deps), 'Hide Row 1');
    expect(await gridOps.toCSV()).not.toContain('hiddenRows');
  });
});
