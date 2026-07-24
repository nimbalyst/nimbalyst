interface RenderOptions {
  onAfterRender?: (doc: Document) => void;
}

/**
 * Helper to render mockup HTML content inside an iframe with basic styling.
 * Shared between the live mockup editor and diff viewer to keep rendering consistent.
 */
export function renderMockupHtml(
  iframe: HTMLIFrameElement | null,
  html: string,
  options?: RenderOptions
) {
  if (!iframe) {
    return;
  }

  try {
    const doc = iframe.contentDocument;
    if (!doc) {
      return;
    }

    doc.open();
    doc.write(`<!DOCTYPE html><html><head><base href="file://${window.location.pathname}"></head><body>${html}</body></html>`);
    doc.close();

    if (doc.body) {
      doc.body.style.margin = '0';
      doc.body.style.fontFamily = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    }
    if (doc.documentElement) {
      doc.documentElement.style.backgroundColor = '#ffffff';
    }

    options?.onAfterRender?.(doc);
  } catch (error) {
    console.error('[MockupRenderer] Failed to render mockup HTML:', error);
  }
}
