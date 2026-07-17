import { describe, expect, it } from 'vitest';
import type { CollaborativeDocumentTypeDescriptor } from '../../../services/CollaborativeDocumentTypeCatalog';
import { splitShareFileName } from '../ShareToTeamDialog';

const descriptor = {
  documentType: 'mockup.html',
  displayName: 'Mockup',
  fileExtensions: ['.mockup.html'],
  defaultExtension: '.mockup.html',
} as CollaborativeDocumentTypeDescriptor;

describe('Share to Team name splitting', () => {
  it('preserves the exact compound suffix while exposing only the base name for editing', () => {
    expect(splitShareFileName('Checkout.mockup.html', descriptor)).toEqual({
      baseName: 'Checkout',
      suffix: '.mockup.html',
    });
  });
});
