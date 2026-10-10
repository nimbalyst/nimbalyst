/**
 * Mermaid loading and rendering, kept free of React/Lexical so it can be
 * tested against the real mermaid library.
 */

// Dynamic import to avoid bundling mermaid when not needed
let mermaidModule: any = null;
let mermaidLoadPromise: Promise<any> | null = null;
let lastInitTheme: string | null = null;

export async function loadMermaid(isDarkTheme: boolean): Promise<any> {
  const themeKey = isDarkTheme ? 'dark' : 'light';

  if (!mermaidLoadPromise) {
    mermaidLoadPromise = (async () => {
      const module = await import('mermaid');
      const mermaid = module.default || (module as any).mermaid || module;
      if (typeof mermaid.initialize !== 'function') {
        console.error('Invalid mermaid instance:', mermaid);
        throw new Error('Failed to load mermaid module');
      }
      mermaidModule = mermaid;
      return mermaid;
    })();
  }

  await mermaidLoadPromise;

  if (lastInitTheme !== themeKey) {
    lastInitTheme = themeKey;
    mermaidModule.initialize({
      startOnLoad: false,
      theme: isDarkTheme ? 'dark' : 'default',
      securityLevel: 'antiscript',
      fontFamily: 'monospace',
      // Without this, a parse failure draws mermaid's error SVG into a temp
      // container on document.body and never removes it. Leaked containers make
      // the document taller than the window, and a scrollIntoView then scrolls
      // the title bar off-screen. MermaidDiagram shows its own error UI instead.
      suppressErrorRendering: true,
    });
  }

  return mermaidModule;
}

export async function renderMermaid(
  elementId: string,
  content: string,
  isDarkTheme: boolean,
): Promise<{ svg: string; bindFunctions?: (element: Element) => void }> {
  const mermaid = await loadMermaid(isDarkTheme);
  try {
    return await mermaid.render(elementId, content);
  } catch (err) {
    // Backstop for failure paths that bypass mermaid's own temp cleanup.
    document.getElementById(`d${elementId}`)?.remove();
    document.getElementById(elementId)?.remove();
    throw err;
  }
}
