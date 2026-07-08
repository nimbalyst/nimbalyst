import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTextCollabContentAdapter } from '../collab/createTextCollabContentAdapter';

const adapter = createTextCollabContentAdapter({
  documentType: 'calc.md',
  fileExtensions: ['.calc.md'],
  mimeType: 'text/markdown',
  textField: 'content',
});

describe('createTextCollabContentAdapter', () => {
  it('reports identity (documentType, extensions, version)', () => {
    expect(adapter.documentType).toBe('calc.md');
    expect(adapter.fileExtensions).toEqual(['.calc.md']);
    expect(adapter.layoutVersion).toBe(1);
  });

  it('isEmpty is true for a fresh Y.Doc and false after seeding', () => {
    const doc = new Y.Doc();
    expect(adapter.isEmpty(doc)).toBe(true);
    adapter.seedFromFile(doc, 'price = 100 USD\n');
    expect(adapter.isEmpty(doc)).toBe(false);
  });

  it('round-trips file content through seed -> export -> plain text', () => {
    const doc = new Y.Doc();
    const source = '# Inputs\nprice = 100 USD\nqty = 3\n';
    adapter.seedFromFile(doc, source);
    expect(adapter.exportToFile(doc)).toBe(source);
    expect(adapter.toPlainText(doc)).toBe(source);
  });

  it('decodes Uint8Array file sources', () => {
    const doc = new Y.Doc();
    const source = 'total = price * qty\n';
    adapter.seedFromFile(doc, new TextEncoder().encode(source));
    expect(adapter.exportToFile(doc)).toBe(source);
  });

  it('seedFromFile is a no-op when the Y.Text is already populated (open race)', () => {
    const doc = new Y.Doc();
    adapter.seedFromFile(doc, 'first');
    adapter.seedFromFile(doc, 'second');
    expect(adapter.exportToFile(doc)).toBe('first');
  });

  it('applyFromFile replaces existing content on a populated Y.Doc', () => {
    const doc = new Y.Doc();
    adapter.seedFromFile(doc, 'old content');
    adapter.applyFromFile(doc, 'brand new content');
    expect(adapter.exportToFile(doc)).toBe('brand new content');
  });

  it('does not re-seed a doc that already received content via sync (race guard)', () => {
    // Models the bootstrap race on a SINGLE shared doc: another client's seed
    // arrives over the wire first, then this client (which had decided the doc
    // was empty) calls seedFromFile. The length guard makes the late seed a
    // no-op, so the synced content is preserved verbatim (no concatenation).
    // The hook layer additionally re-checks isEmpty before seeding.
    const remote = new Y.Doc();
    adapter.seedFromFile(remote, 'a = 1\nb = 2\n');

    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote)); // remote seed arrives
    adapter.seedFromFile(local, 'a = 1\nb = 2\n'); // late local seed -> no-op

    expect(adapter.exportToFile(local)).toBe('a = 1\nb = 2\n');
  });
});
