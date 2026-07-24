import { describe, expect, it } from 'vitest';

import { nimbalystExternalsPlugin } from '../externalsPlugin';

describe('nimbalystExternalsPlugin runtime bridge', () => {
  it('emits named exports for host-provided tracker reference APIs', async () => {
    const plugin = nimbalystExternalsPlugin();
    const resolveId = plugin.resolveId as (...args: unknown[]) => unknown;
    const load = plugin.load as (...args: unknown[]) => unknown;

    const id = await resolveId('@nimbalyst/runtime', undefined, {});
    expect(id).toBe('\0nimbalyst-external:@nimbalyst/runtime');

    const source = await load(id);
    expect(source).toContain('export const TrackerReferenceChip');
    expect(source).toContain('export const TrackerReferencePicker');
    expect(source).toContain('export const useResolvedTrackerReference');
    expect(source).toContain('export const navigateToTrackerReference');
  });

  it('evaluates the react-dom bridge against the React 19 host export shape', async () => {
    const plugin = nimbalystExternalsPlugin();
    const resolveId = plugin.resolveId as (...args: unknown[]) => unknown;
    const load = plugin.load as (...args: unknown[]) => unknown;

    const id = await resolveId('react-dom', undefined, {});
    expect(id).toBe('\0nimbalyst-external:react-dom');

    const source = await load(id);
    expect(typeof source).toBe('string');
    expect(source).not.toContain('export const render');
    expect(source).not.toContain('export const hydrate');
    expect(source).not.toContain('export const findDOMNode');
    expect(source).not.toContain('export const unmountComponentAtNode');

    const createPortal = () => null;
    const preload = () => undefined;
    const hostReactDOM = {
      createPortal,
      flushSync: () => undefined,
      preload,
      version: '19.2.7',
    };

    const executableSource = String(source)
      .replace('export default __nimbalyst_mod__;', 'const __default__ = __nimbalyst_mod__;')
      .replace(/export const (\w+) =/g, 'const $1 =');
    const evaluate = new Function(
      'window',
      `${executableSource}
      return {
        default: __default__, createPortal, preload, preconnect, version,
        render: typeof render === 'undefined' ? undefined : render,
        hydrate: typeof hydrate === 'undefined' ? undefined : hydrate,
        findDOMNode: typeof findDOMNode === 'undefined' ? undefined : findDOMNode,
        unmountComponentAtNode: typeof unmountComponentAtNode === 'undefined'
          ? undefined
          : unmountComponentAtNode,
      };`
    ) as (window: unknown) => unknown;

    const evaluated = evaluate({
      __nimbalyst_extensions: {
        'react-dom': hostReactDOM,
      },
    });
    expect(evaluated).toBeTypeOf('object');

    const exports = evaluated as Record<string, unknown>;
    expect(exports.default).toBe(hostReactDOM);
    expect(exports.createPortal).toBe(createPortal);
    expect(exports.preload).toBe(preload);
    expect(exports.preconnect).toBeUndefined();
    expect(exports.version).toBe('19.2.7');
    expect(exports.render).toBeUndefined();
    expect(exports.hydrate).toBeUndefined();
    expect(exports.findDOMNode).toBeUndefined();
    expect(exports.unmountComponentAtNode).toBeUndefined();
  });
});
