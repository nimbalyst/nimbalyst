// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomEditorWrapper } from '../CustomEditorWrapper';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

afterEach(cleanup);

describe('CustomEditorWrapper extension reload', () => {
  it('unmounts the stale editor when the registry supplies a rebuilt component', () => {
    const staleUnmounted = vi.fn();
    const StaleEditor = () => {
      useEffect(() => staleUnmounted, []);
      return <div>stale bundle</div>;
    };
    const RebuiltEditor = () => <div>rebuilt bundle</div>;
    const host = {} as React.ComponentProps<typeof CustomEditorWrapper>['host'];

    const view = render(
      <CustomEditorWrapper
        component={StaleEditor}
        host={host}
        extensionId="com.nimbalyst.test"
        componentName="TestEditor"
      />,
    );
    screen.getByText('stale bundle');

    view.rerender(
      <CustomEditorWrapper
        component={RebuiltEditor}
        host={host}
        extensionId="com.nimbalyst.test"
        componentName="TestEditor"
      />,
    );

    expect(staleUnmounted).toHaveBeenCalledOnce();
    screen.getByText('rebuilt bundle');
  });
});
