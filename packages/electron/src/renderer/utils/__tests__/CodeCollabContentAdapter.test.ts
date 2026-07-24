import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CODE_COLLAB_FILE_EXTENSIONS,
  CodeCollabContentAdapter,
  getCodeCollabExportFileName,
} from '../CodeCollabContentAdapter';
import { MONACO_TEXT_FILE_EXTENSIONS } from '../fileTypeDetector';

describe('CodeCollabContentAdapter', () => {
  it('covers every Monaco text suffix except markdown routes', () => {
    expect(CodeCollabContentAdapter.documentType).toBe('code');
    expect(CodeCollabContentAdapter.fileExtensions).toEqual(
      MONACO_TEXT_FILE_EXTENSIONS.filter(
        suffix => suffix !== '.md' && suffix !== '.markdown' && suffix !== '.mdc',
      ),
    );
    expect(CodeCollabContentAdapter.fileExtensions).toBe(CODE_COLLAB_FILE_EXTENSIONS);
  });

  it('round-trips seeded source text through the shared content field', () => {
    const doc = new Y.Doc();
    const source = 'export const answer = 42;\n';

    CodeCollabContentAdapter.seedFromFile(doc, source);

    expect(CodeCollabContentAdapter.exportToFile(doc)).toBe(source);
    expect(doc.getText('content').toString()).toBe(source);
  });

  it('decodes Uint8Array source content', () => {
    const doc = new Y.Doc();
    const source = 'print("shared")\n';

    CodeCollabContentAdapter.seedFromFile(doc, new TextEncoder().encode(source));

    expect(CodeCollabContentAdapter.exportToFile(doc)).toBe(source);
  });

  it('replaces existing content when applying a file', () => {
    const doc = new Y.Doc();
    CodeCollabContentAdapter.seedFromFile(doc, 'const oldValue = true;\n');

    CodeCollabContentAdapter.applyFromFile(doc, 'const newValue = true;\n');

    expect(CodeCollabContentAdapter.exportToFile(doc)).toBe('const newValue = true;\n');
  });

  it('merges concurrent edits across Y.Docs', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    CodeCollabContentAdapter.seedFromFile(left, 'const values = [];\n');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    left.getText('content').insert(left.getText('content').length, '// left\n');
    right.getText('content').insert(right.getText('content').length, '// right\n');

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    const merged = CodeCollabContentAdapter.exportToFile(left);
    expect(CodeCollabContentAdapter.exportToFile(right)).toBe(merged);
    expect(merged).toContain('// left\n');
    expect(merged).toContain('// right\n');
  });

  it('prefers the exact V2 suffix when naming an exported copy', () => {
    expect(getCodeCollabExportFileName('src/example.js', '.ts')).toBe('example.ts');
    expect(getCodeCollabExportFileName('types.d.ts', '.d.ts')).toBe('types.d.ts');
    expect(getCodeCollabExportFileName('script.py')).toBe('script.py');
  });
});
