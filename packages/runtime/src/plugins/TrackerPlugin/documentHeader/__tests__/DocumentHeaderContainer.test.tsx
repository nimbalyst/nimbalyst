// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentHeaderContainer } from '../DocumentHeaderContainer';
import { DocumentHeaderRegistry } from '../DocumentHeaderRegistry';

describe('DocumentHeaderContainer provider exclusion', () => {
  afterEach(() => {
    DocumentHeaderRegistry.unregister('test-tracker-header');
    DocumentHeaderRegistry.unregister('test-generic-header');
  });

  it('excludes only the named provider and preserves other matching headers', () => {
    DocumentHeaderRegistry.register({
      id: 'test-tracker-header',
      priority: 10,
      shouldRender: () => true,
      component: () => <div>tracker header</div>,
    });
    DocumentHeaderRegistry.register({
      id: 'test-generic-header',
      priority: 1,
      shouldRender: () => true,
      component: ({ trackerFieldCapabilities }) => (
        <div data-testid="generic-header" data-can-create={String(Boolean(
          trackerFieldCapabilities?.onCreateCollection,
        ))}>
          generic header
        </div>
      ),
    });

    render(
      <DocumentHeaderContainer
        filePath="/workspace/plan.md"
        fileName="plan.md"
        getContent={() => '---\ntype: plan\n---'}
        excludedProviderIds={['test-tracker-header']}
        trackerFieldCapabilities={{ onCreateCollection: async () => null }}
      />,
    );

    expect(screen.queryByText('tracker header')).toBeNull();
    screen.getByText('generic header');
    expect(screen.getByTestId('generic-header').getAttribute('data-can-create')).toBe('true');
  });
});
