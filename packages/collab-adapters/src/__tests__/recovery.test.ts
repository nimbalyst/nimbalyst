import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import type { CollabContentAdapter } from '../CollabContentAdapter';
import { exportCollabRecoveryPlaintext } from '../recovery';

describe('exportCollabRecoveryPlaintext', () => {
  it('uses the round-trippable file export instead of the lossy search projection', () => {
    const adapter: CollabContentAdapter = {
      documentType: 'drawing',
      fileExtensions: ['.drawing'],
      layoutVersion: 1,
      isEmpty: () => false,
      seedFromFile: () => undefined,
      applyFromFile: () => undefined,
      exportToFile: () => '{"elements":[{"type":"rectangle"}]}',
      toPlainText: () => 'visible labels only',
    };

    expect(exportCollabRecoveryPlaintext(adapter, new Y.Doc())).toBe(
      '{"elements":[{"type":"rectangle"}]}',
    );
  });

  it('decodes a UTF-8 file export without changing its bytes', () => {
    const adapter: CollabContentAdapter = {
      documentType: 'text-binary',
      fileExtensions: ['.txt'],
      layoutVersion: 1,
      isEmpty: () => false,
      seedFromFile: () => undefined,
      applyFromFile: () => undefined,
      exportToFile: () => new TextEncoder().encode('recovery text'),
      toPlainText: () => 'lossy',
    };

    expect(exportCollabRecoveryPlaintext(adapter, new Y.Doc())).toBe('recovery text');
  });
});
