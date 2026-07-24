# Nimbalyst Web Clipper

A Chrome browser extension that clips web pages to your Nimbalyst workspace as clean markdown files.

## How It Works

1. Click the extension icon (or right-click for context menu)
2. The extension converts the page to markdown and sends it to the Nimbalyst desktop app over HTTP
3. Nimbalyst saves the clip as a markdown file in `nimbalyst-local/clips/` with YAML frontmatter (title, URL, timestamp)
4. The file opens automatically in the editor

**Requires the Nimbalyst desktop app to be running.**

## Features

- **Clip Page**: Convert the full page content to markdown
- **Clip Selection**: Clip only selected text
- **Context Menu**: Right-click on any page to clip
- **Smart Content Detection**: Finds the main article content and strips navigation, ads, and other noise
- **Metadata Extraction**: Captures page title, URL, author, and publication date

## Installation

### From Source (Development)

```bash
cd packages/browser-extension
npm install
npm run build
```

Then load in Chrome:
1. Go to `chrome://extensions/`
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked"
4. Select the `dist` directory

### Chrome Web Store

Register a Chrome Web Store developer account ($5 one-time fee) at https://chrome.google.com/webstore/devconsole, then:

1. Build the extension: `npm run build`
2. Create a zip of the `dist/` directory: `cd dist && zip -r ../nimbalyst-web-clipper.zip . && cd ..`
3. Upload the zip in the developer console
4. Fill in the store listing:
  - **Description**: Use the summary from this README
  - **Category**: Productivity
  - **Screenshots**: 1280x800 or 640x400 showing the popup in action
  - **Privacy policy**: Required (see below)
5. Submit for review (typically 1-3 business days)

### Privacy Policy

Required for Chrome Web Store submission. Key points to include:

- The extension reads page content only when the user clicks "Clip" or uses the context menu
- Content is sent only to `127.0.0.1` (the user's local Nimbalyst app) -- never to external servers
- No data is collected, stored, or transmitted to third parties
- No analytics or tracking

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current page content when the user clicks clip |
| `contextMenus` | Add "Clip page/selection to Nimbalyst" to the right-click menu |
| `http://127.0.0.1/*` | Send clips to the locally running Nimbalyst app |

The `content_scripts` declaration with `<all_urls>` is needed so the content script (which converts HTML to markdown) is available on all pages. It only activates when the user explicitly clips.

## Development

```bash
npm run build        # Build once
npm run watch        # Build and watch for changes
```

### Architecture

- **Content Script** (`content.js`): Runs on web pages. Converts HTML to markdown using Turndown. Strips noise elements (nav, ads, sidebar). Scores candidate content containers by text length to find the best one.
- **Background Service Worker** (`background.js`): Manages context menus. Sends clips to Nimbalyst's local HTTP server (port 3456+) via POST to `/clip`.
- **Popup UI** (`popup.html/js/css`): Two-button interface -- "Clip Page" and "Clip Selection".

### File Structure

```
packages/browser-extension/
  src/
    background/background.js   # Service worker
    content/content.js         # Content script (HTML -> markdown)
    popup/popup.html/css/js    # Popup UI
  icons/                       # Extension icons (16/32/48/128px)
  manifest.json                # Chrome Manifest V3
  build.js                     # esbuild bundler
  package.json
```

## Browser Support

- Chrome (Manifest V3)
- Edge (Chromium-based)

Firefox and Safari would need minor manifest changes.

## Troubleshooting

**Extension popup says "Error loading page. Try refreshing."**
The content script hasn't loaded on this page yet. Refresh the page and try again.

**Clip fails with "Could not connect to Nimbalyst. Is it running?"**
The Nimbalyst desktop app needs to be running. The extension communicates with it over `http://127.0.0.1:3456`.

**Clip succeeds but content is empty or incomplete**
Some sites load content dynamically after page load. Wait for the page to fully render before clipping. Sites behind paywalls may only expose the visible portion.
