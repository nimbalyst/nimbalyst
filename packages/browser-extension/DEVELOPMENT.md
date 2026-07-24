# Browser Extension Development Guide

This guide covers development, testing, and debugging of the Nimbalyst browser extension.

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- Chrome browser (for testing)
- Nimbalyst desktop app installed

### Initial Setup

```bash
cd packages/browser-extension
npm install
npm run build
```

### Development Workflow

```bash
# Watch mode - rebuilds on file changes
npm run watch

# Manual build
npm run build

# Clean and rebuild
npm run clean && npm run build
```

## Loading the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right corner)
3. Click "Load unpacked"
4. Select the `packages/browser-extension/dist` directory
5. The extension should appear in your toolbar

**Note:** After making code changes and rebuilding, you need to:
- Click the refresh icon on the extension card in `chrome://extensions/`, OR
- Remove and re-load the extension

## Testing

### Manual Testing Checklist

Test the extension on different types of web pages:

#### Simple Content
- [ ] Wikipedia article
- [ ] Medium blog post
- [ ] GitHub README

#### Complex Content
- [ ] E-commerce site (product listings)
- [ ] News site with multimedia
- [ ] Documentation site with code blocks
- [ ] Social media page

#### Special Cases
- [ ] Page with authentication/login required
- [ ] Page with dynamic content (JavaScript-heavy)
- [ ] Page with lots of images
- [ ] Page with tables and complex formatting
- [ ] Single-page application (React, Vue, etc.)

### Testing Scenarios

#### 1. Basic Page Clipping

1. Navigate to a Wikipedia article
2. Click the extension icon
3. Click "Clip Page"
4. Verify:
   - Nimbalyst opens/activates
   - New markdown file created in `.nimbalyst/web-clippings/`
   - Content is properly formatted
   - Images are referenced as URLs
   - Metadata (title, URL, timestamp) is in frontmatter

#### 2. Selection Clipping

1. Navigate to any article
2. Select a paragraph of text
3. Click the extension icon
4. Click "Clip Selection"
5. Verify:
   - Only selected content is clipped
   - Selection is preserved in frontmatter
   - Full page content is also available

#### 3. Context Menu

1. Right-click anywhere on a page
2. Verify context menu shows:
   - "Clip page to Nimbalyst"
   - "Clip selection to Nimbalyst" (if text selected)
   - "Extract with AI..."
3. Test each option

#### 4. AI Extraction

1. Navigate to a product page
2. Click extension icon
3. Click "Extract with AI"
4. Enter prompt: "Extract product name, price, and main features"
5. Click "Extract"
6. Verify:
   - AI prompt is included in clip
   - Nimbalyst processes with AI
   - Extracted content is formatted as requested

#### 5. Large Content Handling

1. Navigate to a very long article (>100KB)
2. Clip the page
3. Verify:
   - Extension handles encoding
   - If content >1.5MB, fallback to URL-only mode triggers
   - Nimbalyst receives and processes correctly

#### 6. Image Handling

1. Navigate to a page with multiple images
2. Clip the page
3. Verify in Nimbalyst:
   - Images appear as markdown references
   - Nimbalyst downloads images to `.nimbalyst/assets/`
   - Markdown is updated with local paths
   - Images render correctly in editor

### Testing Different Websites

**Good test sites:**
- **Wikipedia**: Clean content, good images, structured data
- **Medium**: Modern blog platform, complex formatting
- **GitHub**: Code blocks, tables, technical content
- **Amazon**: Product pages, complex layout, lots of images
- **Stack Overflow**: Q&A format, code snippets
- **Documentation sites**: MDN, React docs, etc.

## Debugging

### Extension Console

Access different console outputs:

1. **Background Service Worker**:
   - Go to `chrome://extensions/`
   - Find Nimbalyst Web Clipper
   - Click "Service worker" link
   - Console opens showing background script logs

2. **Content Script**:
   - Open DevTools on any web page (F12)
   - Content script logs appear in page console

3. **Popup**:
   - Right-click the extension icon
   - Select "Inspect popup"
   - DevTools opens for popup UI

### Common Issues and Solutions

#### Extension doesn't load
- Check manifest.json syntax
- Ensure all referenced files exist
- Check Chrome console for errors
- Verify file paths in manifest match actual structure

#### Content script not running
- Check manifest permissions
- Verify content script is injected: check page console
- Look for CSP (Content Security Policy) restrictions
- Try reloading the page after installing extension

#### Background service worker not starting
- Check service worker console for errors
- Verify module imports are correct
- Ensure background.js is valid ES module
- Try unloading and reloading extension

#### Clipping doesn't trigger Nimbalyst
- Verify `nimbalyst://` protocol is registered
- Test protocol manually: open `nimbalyst://clip?url=test&title=test` in browser
- Check that Nimbalyst app is installed
- Look for OS-level protocol handler issues

#### Markdown conversion issues
- Check Turndown configuration
- Test on simpler pages first
- Look for JavaScript errors in content script
- Verify HTML structure is being parsed

#### Base64 encoding errors
- Check for special characters in content
- Verify UTF-8 encoding is handled correctly
- Test with different character sets
- Look for truncation or corruption

### Debugging Tips

1. **Add breakpoints**: Use Chrome DevTools to set breakpoints in code
2. **Console logging**: Add `console.log` statements liberally during development
3. **Network inspection**: Use Network tab to see if content is loading
4. **Storage inspection**: Check chrome.storage to verify saved data
5. **Incremental testing**: Test each component separately before integration

### Testing Protocol URLs

You can test protocol URL generation manually:

```javascript
// In browser console
const params = new URLSearchParams({
  url: 'https://example.com',
  title: 'Test Page',
  content: btoa('# Test\n\nContent here')
});
const url = `nimbalyst://clip?${params.toString()}`;
console.log(url);

// Then paste the URL in browser to test
```

## Build Configuration

The extension uses esbuild for bundling:

- **Entry points**: `src/background/background.js`, `src/content/content.js`, `src/popup/popup.js`
- **Output**: `dist/` directory
- **Format**: ES modules
- **Target**: Chrome 120+
- **Source maps**: Enabled for debugging

### Modifying the Build

Edit `build.js` to:
- Add new entry points
- Change output directory
- Adjust esbuild configuration
- Add build-time optimizations

## Code Structure

### Content Script (content.js)

Responsibilities:
- Initialize Turndown service
- Extract main content from page
- Convert HTML to markdown
- Handle image URL conversion
- Extract page metadata
- Handle text selections
- Respond to messages from background script

Key functions:
- `convertPageToMarkdown()`: Main conversion logic
- `extractMainContent()`: Find article content
- `getPageMetadata()`: Extract title, author, date, etc.
- `getSelectedMarkdown()`: Convert selection to markdown

### Background Service Worker (background.js)

Responsibilities:
- Create and manage context menus
- Handle context menu clicks
- Generate `nimbalyst://` protocol URLs
- Base64 encode content
- Handle size limits and fallbacks
- Route messages between components

Key functions:
- `generateClipURL()`: Create protocol URL
- `sendClipToNimbalyst()`: Open protocol URL
- `base64Encode()`: UTF-8 safe encoding
- `handleClipPage()`: Process clip requests

### Popup UI (popup.js/html/css)

Responsibilities:
- Display quick action buttons
- Show current page info
- Handle AI prompt input
- Communicate with background script
- Show status messages

Components:
- Clip Page button
- Clip Selection button (enabled only with selection)
- Extract with AI button (shows prompt input)
- Status message area
- Page info display

## Adding New Features

### Adding a New Content Extraction Rule

Edit `src/content/content.js`:

```javascript
turndown.addRule('customRule', {
  filter: 'selector',
  replacement: (content, node) => {
    // Custom conversion logic
    return transformedContent;
  }
});
```

### Adding a New Context Menu Option

Edit `src/background/background.js`:

```javascript
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'my-action',
    title: 'My Action',
    contexts: ['page', 'selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'my-action') {
    // Handle the action
  }
});
```

### Adding a New Popup Action

1. Add button to `src/popup/popup.html`
2. Style it in `src/popup/popup.css`
3. Add event listener in `src/popup/popup.js`
4. Send message to background script
5. Handle in background script

## Performance Considerations

- **Content size**: Monitor memory usage for large pages
- **Image count**: Markdown with many images can be large
- **DOM traversal**: Optimize content extraction for complex pages
- **Encoding speed**: Base64 encoding is fast but memory-intensive
- **Background tasks**: Service worker can be terminated by Chrome, keep stateless

## Security Considerations

- Never send data to external servers
- Validate all input from web pages
- Sanitize URLs before encoding
- Be careful with eval() and innerHTML
- Respect Content Security Policy (CSP)
- Handle cross-origin restrictions properly

## Browser Compatibility

Current support:
- Chrome 120+ (Manifest V3)
- Edge (Chromium-based)

For Firefox/Safari support in the future:
- Will need manifest.json adaptations
- May need different APIs for some features
- Service worker vs background page differences

## Publishing

Not yet ready for Chrome Web Store, but when ready:

1. Update version in manifest.json and package.json
2. Build production version: `npm run build`
3. Create ZIP of `dist/` directory
4. Upload to Chrome Web Store Developer Dashboard
5. Fill out store listing (description, screenshots, etc.)
6. Submit for review

## Resources

- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Turndown Documentation](https://github.com/domchristie/turndown)
- [esbuild Documentation](https://esbuild.github.io/)
