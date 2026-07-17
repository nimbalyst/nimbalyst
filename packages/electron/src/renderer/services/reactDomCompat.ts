type ReactDomLike = Record<string, unknown>;
type ReactDomClientLike = {
  createRoot: unknown;
  hydrateRoot: unknown;
};

/**
 * Build the 'react-dom' object exposed to extensions via
 * window.__nimbalyst_extensions.
 *
 * React 19 removed createRoot/hydrateRoot from the react-dom root entry
 * (client-only entry now owns them). Extension bundles built before the
 * React 19 upgrade embed react-dom/client CJS interop that resolves
 * createRoot off the externalized 'react-dom' key, so the host must keep
 * exposing the pre-19 shape or those published bundles crash at mount
 * ("clientExports.createRoot is not a function").
 *
 * Returns a plain mutable object: ES module namespace objects are frozen,
 * so spreading is also what allows the compat members to be attached.
 */
export function createReactDomCompat<T extends ReactDomLike>(
  reactDom: T,
  reactDomClient: ReactDomClientLike
): T & ReactDomClientLike {
  return {
    createRoot: reactDomClient.createRoot,
    hydrateRoot: reactDomClient.hydrateRoot,
    ...reactDom,
  } as T & ReactDomClientLike;
}
