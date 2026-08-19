interface RenderOptions {
  onAfterRender?: (doc: Document) => void;
}

export interface MockupRenderResult {
  /**
   * Whether the frame ran the scripts written into it.
   *
   * `false` means the host's Content-Security-Policy blocked them. A mockup
   * frame is written with `doc.write()` into `about:blank`, and a local-scheme
   * document inherits its creator's policy — so on the web console, whose
   * `script-src` is `'self'` with no `'unsafe-inline'`, a mockup's own inline
   * scripts do not run. Nothing in the frame can lift that: additional policies
   * only ever intersect, so a `<meta>` CSP inside cannot loosen it, and
   * `sandbox` changes the frame's origin rather than which policy applies.
   * Desktop has no such policy and runs them.
   *
   * This is measured rather than inferred from the host, because the answer
   * depends on the CSP the page was served with — which the editor cannot see.
   */
  scriptsRan: boolean;
}

const SCRIPT_PROBE_FLAG = '__nimbalystMockupScriptProbe';

/** Whether the author's mockup has any script at all to be blocked. */
export function mockupHasScript(html: string): boolean {
  return /<script[\s>]/i.test(html);
}

/**
 * The `<base>` a mockup's relative URLs resolve against.
 *
 * A `doc.write()` document has no URL of its own, so without a base every
 * relative `src`/`href` in the mockup resolves against `about:blank` and loads
 * nothing. The base therefore has to come from the page hosting the editor.
 *
 * This used to be hardcoded to `file://${location.pathname}`, which is only ever
 * right in Electron. On the web console the page is served over https, and a
 * `file://` base sends every relative URL in the mockup to a scheme the page is
 * not allowed to load. Deriving it from the current document keeps desktop
 * behaviour identical and makes the browser resolve against its own origin.
 */
function mockupBaseHref(): string {
  const { origin, pathname, protocol } = window.location;
  // `origin` is the string "null" for an opaque origin, and Electron's file://
  // documents historically reported no usable origin at all.
  return protocol === 'file:' || !origin || origin === 'null'
    ? `${protocol}//${pathname}`
    : new URL(pathname, origin).href;
}

/**
 * Helper to render mockup HTML content inside an iframe with basic styling.
 * Shared between the live mockup editor and diff viewer to keep rendering consistent.
 */
export function renderMockupHtml(
  iframe: HTMLIFrameElement | null,
  html: string,
  options?: RenderOptions
): MockupRenderResult {
  if (!iframe) {
    return { scriptsRan: false };
  }

  try {
    const doc = iframe.contentDocument;
    if (!doc) {
      return { scriptsRan: false };
    }

    // The probe sits in <head>, not in the body: a CSP blocks every inline
    // script in the document alike, so placement does not change the answer,
    // and a script node inside <body> would show up in the body's textContent
    // for anything that reads the rendered mockup back. `doc.write()` executes
    // inline scripts synchronously as it parses, so the flag is readable by the
    // time `close()` returns.
    doc.open();
    doc.write(
      `<!DOCTYPE html><html><head><base href="${mockupBaseHref()}">`
      + `<script>window.${SCRIPT_PROBE_FLAG}=true;</script></head>`
      + `<body>${html}</body></html>`
    );
    doc.close();

    if (doc.body) {
      doc.body.style.margin = '0';
      doc.body.style.fontFamily = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    }
    if (doc.documentElement) {
      doc.documentElement.style.backgroundColor = '#ffffff';
    }

    options?.onAfterRender?.(doc);

    return {
      scriptsRan: (iframe.contentWindow as Record<string, unknown> | null)
        ?.[SCRIPT_PROBE_FLAG] === true,
    };
  } catch (error) {
    console.error('[MockupRenderer] Failed to render mockup HTML:', error);
    return { scriptsRan: false };
  }
}
