// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { CsvCollabContentAdapter } from '../CsvCollabContentAdapter';
import { resolveFileDelimiter } from '../../utils/csvParser';

describe('CsvCollabContentAdapter', () => {
  it('round-trips a TSV file through the Y.Text with its tabs intact', () => {
    const tsv = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0}\nName\tNote\nAlpha\t"a, b"';
    expect(CsvCollabContentAdapter.fileExtensions).toContain('.tsv');

    const seeded = new Y.Doc();
    CsvCollabContentAdapter.seedFromFile(seeded, new TextEncoder().encode(tsv));
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(seeded));

    const exported = CsvCollabContentAdapter.exportToFile(replica);
    expect(exported).toBe(tsv);
    // What the editor reads back on load is what it writes on save.
    expect(resolveFileDelimiter(exported as string, '/shared/notes.tsv')).toBe('\t');
  });
});
