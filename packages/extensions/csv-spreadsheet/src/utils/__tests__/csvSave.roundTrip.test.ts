// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGridOperations } from '../gridOperations';
import { detectFileLayout, parseCSV } from '../csvParser';
import { createFakeGrid, createMetaStore } from '../../commands/__tests__/fakeGrid';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(async () => undefined), readClipboard: vi.fn(async () => '') }));

/** Open `csv` the way the editor does and return its grid operations. */
function open(csv: string) {
  const { grid, parsed } = createFakeGrid(csv, 2);
  const meta = createMetaStore(parsed);
  const ops = createGridOperations({ current: grid }, {
    ...meta,
    getDelimiter: () => parsed.delimiter,
    getFileLayout: () => detectFileLayout(csv),
  });
  return { ops, meta };
}

/**
 * A plain CSV stays plain: the `# nimbalyst:` line is written only for
 * something the user set. An auto-detected header row is not that -- the
 * reload detects it again from the same bytes.
 */
describe('plain CSV save', () => {
  it.each([
    ['header row and trailing newline', 'Name,Qty\nBob,2\nAmy,3\n'],
    ['no trailing newline', 'Name,Qty\nBob,2'],
    ['CRLF line endings', 'Name,Qty\r\nBob,2\r\n'],
    ['numbers written as text', 'Code,Price\n007,1.50\n0042,1e5\n'],
    ['tab separated', 'a\tb\n1\t2\n'],
    ['no header', '1,2\n3,4\n'],
  ])('is byte-identical after open and save: %s', async (_name, csv) => {
    expect(await open(csv).ops.toCSV()).toBe(csv);
  });

  it('stays plain after a cell edit, and the reload detects the same header', async () => {
    const { ops } = open('Name,Qty\nBob,2\n');
    await ops.updateCell(1, 1, '5');
    const saved = await ops.toCSV();
    expect(saved).toBe('Name,Qty\nBob,5\n');
    expect(parseCSV(saved).data.headerRowCount).toBe(1);
  });

  // Saving trims empty trailing columns; header detection must give the same
  // answer before and after, or the save writes a line to pin the old answer.
  it('stays plain when the save trims empty trailing columns', async () => {
    const { ops } = open('A,B,,,\n1,2,,,\n');
    await ops.updateCell(0, 0, 'Z');
    expect(await ops.toCSV()).toBe('Z,B\n1,2\n');
  });

  it('keeps a header count the user set', async () => {
    const csv = '# nimbalyst: {"hasHeaders":true,"headerRowCount":2,"frozenColumnCount":0}\nA,B\nC,D\n1,2\n';
    expect(await open(csv).ops.toCSV()).toBe(csv);
  });

  // The load pins only the populated rows; the header count must not give way to that clamp.
  it('R4-2: keeps header and frozen counts when rows are frozen past the populated data', async () => {
    const { ops } = open('Name,Qty\nBob,2\nAmy,3\n');
    await ops.updateHeaderRowCount(1);
    await ops.setMeta({ frozenRowCount: 5 });
    const saved = await ops.toCSV();
    expect(parseCSV(saved).data).toMatchObject({ headerRowCount: 1, frozenRowCount: 5 });

    const reopened = open(saved).ops;
    const resaved = await reopened.toCSV();
    expect(resaved).toBe(saved);
    await reopened.updateCell(2, 1, '4');
    expect(parseCSV(await reopened.toCSV()).data).toMatchObject({ headerRowCount: 1, frozenRowCount: 5 });
  });

  it('writes the line when the user turns off a detected header', async () => {
    const { ops } = open('Name,Qty\nBob,2\n');
    await ops.updateHeaderRowCount(0);
    const saved = await ops.toCSV();
    expect(saved.startsWith('# nimbalyst:')).toBe(true);
    expect(parseCSV(saved).data.headerRowCount).toBe(0);
  });

  it('keeps an existing line even when everything is at its default', async () => {
    const csv = '# nimbalyst: {"hasHeaders":false,"headerRowCount":0,"frozenColumnCount":0}\n1,2\n';
    expect((await open(csv).ops.toCSV()).startsWith('# nimbalyst:')).toBe(true);
  });
});
