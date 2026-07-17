import { describe, expect, it } from 'vitest';
import { createReactDomCompat } from '../reactDomCompat';

// React 19 removed createRoot/hydrateRoot from the react-dom root entry.
// Extension bundles built before the React 19 upgrade contain react-dom/client
// CJS interop that resolves createRoot off the externalized 'react-dom' host
// key (observed live: "clientExports.createRoot is not a function" from the
// Jupyter extension after the 19 upgrade). The host must expose a compat
// object that restores the pre-19 shape.
describe('createReactDomCompat', () => {
  const reactDom19 = Object.freeze({
    createPortal: () => 'portal',
    flushSync: (fn: () => void) => fn(),
    version: '19.2.7',
    // Note: no createRoot/hydrateRoot on the root entry in React 19.
  });
  const reactDomClient19 = Object.freeze({
    createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
    hydrateRoot: () => ({ render: () => undefined, unmount: () => undefined }),
    version: '19.2.7',
  });

  it('exposes createRoot and hydrateRoot from react-dom/client on the react-dom key', () => {
    const compat = createReactDomCompat(reactDom19, reactDomClient19);
    expect(compat.createRoot).toBe(reactDomClient19.createRoot);
    expect(compat.hydrateRoot).toBe(reactDomClient19.hydrateRoot);
  });

  it('preserves all react-dom root-entry exports', () => {
    const compat = createReactDomCompat(reactDom19, reactDomClient19);
    expect(compat.createPortal).toBe(reactDom19.createPortal);
    expect(compat.flushSync).toBe(reactDom19.flushSync);
    expect(compat.version).toBe('19.2.7');
  });

  it('returns a mutable plain object (module namespaces are frozen and cannot be patched)', () => {
    const compat = createReactDomCompat(reactDom19, reactDomClient19);
    expect(() => {
      (compat as Record<string, unknown>).__probe = 1;
    }).not.toThrow();
  });

  it('prefers the root-entry member when react-dom itself provides it (React 18 host)', () => {
    const legacyCreateRoot = () => 'legacy';
    const reactDom18 = { ...reactDom19, createRoot: legacyCreateRoot };
    const compat = createReactDomCompat(reactDom18, reactDomClient19);
    expect(compat.createRoot).toBe(legacyCreateRoot);
  });
});
