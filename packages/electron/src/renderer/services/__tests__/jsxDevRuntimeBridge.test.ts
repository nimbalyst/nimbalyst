import { describe, expect, it } from 'vitest';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import * as jsxRuntime from 'react/jsx-runtime';

import { createJsxDevRuntimeBridge } from '../jsxDevRuntimeBridge';

describe('createJsxDevRuntimeBridge', () => {
  it('preserves the React 19 jsx-dev-runtime export shape', () => {
    const bridge = createJsxDevRuntimeBridge(jsxDevRuntime, jsxRuntime);

    expect(Object.keys(jsxDevRuntime).sort()).toEqual(
      expect.arrayContaining(['Fragment', 'jsxDEV'])
    );
    expect(bridge.Fragment).toBe(jsxDevRuntime.Fragment);
    expect(bridge.jsxDEV).toBe(jsxDevRuntime.jsxDEV);
  });

  it('uses the production jsx factory when jsxDEV is absent', () => {
    const bridge = createJsxDevRuntimeBridge(
      { Fragment: jsxDevRuntime.Fragment },
      jsxRuntime
    );

    const element = bridge.jsxDEV(
      'div',
      { 'data-testid': 'shimmed-element' },
      'shim-key',
      false,
      undefined,
      undefined
    );

    expect(element).toMatchObject({
      type: 'div',
      key: 'shim-key',
      props: { 'data-testid': 'shimmed-element' },
    });
  });
});
