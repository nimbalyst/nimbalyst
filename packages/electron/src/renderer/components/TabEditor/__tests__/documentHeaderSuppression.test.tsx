// @vitest-environment jsdom
/**
 * A frontmatter-projected tracker document (a plan, a decision, ...) would show
 * its Status/Priority/Owner form twice when opened inside a host that already
 * shows those same fields as chips -- Tracker Mode's expanded document view.
 * This context is how such a host tells the `TabEditor` beneath it to drop the
 * in-document copy, so the default has to stay "show it": an ordinary file tab
 * mounts outside any provider and must be unaffected.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DocumentHeaderSuppressionProvider,
  useSuppressedDocumentHeaderProviderIds,
} from '../DocumentHeaderSuppressionContext';

/** Stands in for the TabEditor deep inside a host's detail subtree. */
const SuppressionProbe: React.FC = () => (
  <div data-testid="probe" data-suppressed={useSuppressedDocumentHeaderProviderIds().join(',')} />
);

function suppressed(): string | null {
  return screen.getByTestId('probe').getAttribute('data-suppressed');
}

describe('document header suppression context', () => {
  it('shows the in-document header when no host claims the fields', () => {
    render(<SuppressionProbe />);

    expect(suppressed()).toBe('');
  });

  it('suppresses only the duplicate tracker provider inside a focused host', () => {
    render(
      <DocumentHeaderSuppressionProvider providerIds={['tracker-document-header']}>
        <div>
          <section>
            <SuppressionProbe />
          </section>
        </div>
      </DocumentHeaderSuppressionProvider>,
    );

    expect(suppressed()).toBe('tracker-document-header');
  });

  it('leaves the header alone when the host is not in its expanded presentation', () => {
    render(
      <DocumentHeaderSuppressionProvider providerIds={[]}>
        <SuppressionProbe />
      </DocumentHeaderSuppressionProvider>,
    );

    expect(suppressed()).toBe('');
  });
});
