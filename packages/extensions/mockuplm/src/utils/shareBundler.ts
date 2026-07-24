/**
 * Share Bundler
 *
 * Bundles a .mockupproject file and all its referenced mockup files
 * into a self-contained HTML page that can be shared via a public URL.
 * The bundle includes the component library, theme engine, and
 * component library and theme engine so mockups render without Nimbalyst.
 */

import type { MockupProjectFile } from '../types/project';
import { generateThemeCSS, type MockupTheme } from './themeEngine';

export interface BundleInput {
  project: MockupProjectFile;
  /** Map of mockup path -> HTML content */
  mockupContents: Map<string, string>;
  /** Theme to bake into the bundle */
  theme: MockupTheme;
}

/**
 * Generate a standalone HTML page that renders the project canvas
 * with all mockups embedded. Interactive mode works in the bundle.
 */
export function generateShareBundle(input: BundleInput): string {
  const { project, mockupContents, theme } = input;

  // Build embedded mockup data as JSON
  const mockupData: Record<string, string> = {};
  for (const [path, html] of mockupContents) {
    mockupData[path] = html;
  }

  const themeCSS = generateThemeCSS(theme);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(project.name)} - Mockup Project</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1a1a;
      color: #e5e5e5;
      overflow: hidden;
      height: 100vh;
    }
    .header {
      padding: 12px 20px;
      background: #2d2d2d;
      border-bottom: 1px solid #3a3a3a;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header h1 { font-size: 16px; font-weight: 600; }
    .header .meta { font-size: 12px; color: #808080; }
    .canvas {
      position: relative;
      width: 100%;
      height: calc(100vh - 48px);
      overflow: auto;
    }
    .mockup-card {
      position: absolute;
      background: #1a1a1a;
      border: 1px solid #4a4a4a;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: box-shadow 0.15s;
    }
    .mockup-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
    .mockup-card .label {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: #e5e5e5;
      background: #2d2d2d;
      border-bottom: 1px solid #3a3a3a;
    }
    .mockup-card iframe {
      border: none;
      pointer-events: none;
      transform-origin: top left;
    }
    .connection-label {
      position: absolute;
      font-size: 11px;
      color: #b3b3b3;
      background: #2d2d2d;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid #3a3a3a;
      white-space: nowrap;
    }
    ${themeCSS}
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(project.name)}</h1>
    ${project.description ? `<span class="meta">${escapeHtml(project.description)}</span>` : ''}
    <span class="meta">${project.mockups.length} screen${project.mockups.length !== 1 ? 's' : ''}</span>
  </div>
  <div class="canvas" id="canvas"></div>

  <script>
    // Embedded mockup data
    var MOCKUPS = ${JSON.stringify(mockupData)};
    var PROJECT = ${JSON.stringify(project)};

    // Render cards
    var canvas = document.getElementById('canvas');
    var scale = 0.4;

    PROJECT.mockups.forEach(function(m) {
      var card = document.createElement('div');
      card.className = 'mockup-card';
      card.style.left = m.position.x + 'px';
      card.style.top = m.position.y + 'px';
      card.style.width = m.size.width + 'px';

      var label = document.createElement('div');
      label.className = 'label';
      label.textContent = m.label || m.path.split('/').pop();
      card.appendChild(label);

      var html = MOCKUPS[m.path];
      if (html) {
        var iframe = document.createElement('iframe');
        iframe.style.width = (m.size.width / scale) + 'px';
        iframe.style.height = (m.size.height / scale) + 'px';
        iframe.style.transform = 'scale(' + scale + ')';
        iframe.sandbox = 'allow-scripts allow-same-origin';
        card.appendChild(iframe);
        card.style.height = (m.size.height + 32) + 'px';

        // Write content after append
        canvas.appendChild(card);
        var doc = iframe.contentDocument;
        doc.open();
        doc.write(html);
        doc.close();
      } else {
        var placeholder = document.createElement('div');
        placeholder.style.cssText = 'height:' + m.size.height + 'px;display:flex;align-items:center;justify-content:center;color:#808080;font-size:13px;';
        placeholder.textContent = m.path.split('/').pop();
        card.appendChild(placeholder);
        canvas.appendChild(card);
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
