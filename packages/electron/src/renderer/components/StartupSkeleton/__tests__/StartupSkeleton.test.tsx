/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StartupSkeleton } from '../StartupSkeleton';

describe('StartupSkeleton', () => {
  it('renders workspace chrome placeholders while a workspace window boots', () => {
    const { container } = render(<StartupSkeleton workspaceMode />);

    expect(container.querySelector('.startup-skeleton__top-bar')).not.toBeNull();
    expect(container.querySelector('.startup-skeleton__gutter')).not.toBeNull();
    expect(container.querySelector('.startup-skeleton__sidebar')).not.toBeNull();
  });

  it('renders only the background for a document window', () => {
    const { container } = render(<StartupSkeleton workspaceMode={false} />);

    // A document window never grows a top bar or sidebar, so showing them here
    // would be chrome that disappears the moment the app takes over.
    expect(container.querySelector('.startup-skeleton__top-bar')).toBeNull();
    expect(container.querySelector('.startup-skeleton__sidebar')).toBeNull();
    expect(container.querySelector('.startup-skeleton--document')).not.toBeNull();
  });
});
