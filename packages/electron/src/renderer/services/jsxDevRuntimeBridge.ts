type JsxDevRuntimeModule = typeof import('react/jsx-dev-runtime');
type JsxRuntimeModule = typeof import('react/jsx-runtime');

/**
 * Preserve React's jsx-dev-runtime exports while providing jsxDEV for hosts
 * whose production condition omits the development-only factory.
 */
export function createJsxDevRuntimeBridge<T extends Partial<JsxDevRuntimeModule>>(
  devRuntime: T,
  runtime: Pick<JsxRuntimeModule, 'jsx'>
): T & { jsxDEV: JsxDevRuntimeModule['jsxDEV'] } {
  const fallbackJsxDEV: JsxDevRuntimeModule['jsxDEV'] = (type, props, key) =>
    runtime.jsx(type, props, key);

  return {
    ...devRuntime,
    jsxDEV: devRuntime.jsxDEV ?? fallbackJsxDEV,
  };
}
