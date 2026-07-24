# Quick Start Guide

Get the Nimbalyst Web Clipper extension up and running in 5 minutes.

## Step 1: Build the Extension

```bash
cd packages/browser-extension
npm install
npm run build
```

This creates a `dist/` directory with the packaged extension.

## Step 2: Load in Chrome

1. Open Chrome and navigate to: `chrome://extensions/`

2. Enable **Developer mode** (toggle switch in top-right corner)

3. Click **"Load unpacked"** button

4. Navigate to and select: `packages/browser-extension/dist`

5. The Nimbalyst Web Clipper icon should appear in your toolbar

## Step 3: Try It Out

**Note**: The extension is fully functional, but requires the Nimbalyst app to have the protocol handler implemented (Phase 2).

### Test the Extension UI

1. Navigate to any website (try Wikipedia)
2. Click the Nimbalyst extension icon in your toolbar
3. You should see:
   - "Clip Page" button
   - "Clip Selection" button (enabled if text is selected)
   - "Extract with AI" button

### Test the Context Menu

1. Right-click anywhere on a web page
2. You should see Nimbalyst options:
   - "Clip page to Nimbalyst"
   - "Clip selection to Nimbalyst" (if text is selected)
   - "Extract with AI..."

### What Happens When You Click?

Currently, when you click to clip:
1. Extension converts the page to markdown
2. Generates a `nimbalyst://clip?...` protocol URL
3. Attempts to open the URL
4. **Browser shows error** (protocol not registered yet)

This is expected - the Nimbalyst app needs to implement the protocol handler (Phase 2).

## What Works Now

- ✅ Extension installs and loads correctly
- ✅ Popup UI displays and functions
- ✅ Context menus appear
- ✅ Content script converts HTML to markdown
- ✅ Metadata extraction works
- ✅ Base64 encoding functions
- ✅ Protocol URLs are generated

## What Needs Phase 2 (Nimbalyst App)

- ⏸️ Protocol handler registration
- ⏸️ Clip processing and file creation
- ⏸️ Image downloading
- ⏸️ AI integration
- ⏸️ Tracker system integration

## Debugging

### View Extension Console

**Background Service Worker**:
1. Go to `chrome://extensions/`
2. Find "Nimbalyst Web Clipper"
3. Click "Service worker" link
4. Console opens with background script logs

**Content Script**:
1. Open any web page
2. Open DevTools (F12)
3. Look for "Nimbalyst Web Clipper content script loaded" message

**Popup**:
1. Right-click extension icon
2. Select "Inspect popup"
3. DevTools opens for popup

### Common Issues

**Extension doesn't appear**:
- Make sure Developer mode is enabled
- Try clicking the puzzle piece icon in Chrome toolbar
- Pin the extension to make it always visible

**Build errors**:
- Make sure you ran `npm install` first
- Check that Node.js 18+ is installed
- Try `npm run clean && npm run build`

**Context menus don't appear**:
- Reload the extension in `chrome://extensions/`
- Try refreshing the web page

## Next Steps

1. **For developers**: See `DEVELOPMENT.md` for detailed development guide

2. **For testing**: See `DEVELOPMENT.md` Testing section for comprehensive test cases

3. **For Nimbalyst integration**: See the plan document at `nimbalyst-local/plans/browser-extension-web-clipping.md`

## File Structure

```
packages/browser-extension/
├── dist/                    # Built extension (load this in Chrome)
├── src/
│   ├── background/         # Service worker
│   ├── content/            # Content script
│   └── popup/              # Popup UI
├── icons/                  # Extension icons (needs real icons)
├── manifest.json           # Extension manifest
├── README.md              # Full user documentation
├── DEVELOPMENT.md         # Developer guide
└── QUICK_START.md         # This file
```

## Getting Help

- Check `README.md` for user documentation
- Check `DEVELOPMENT.md` for developer documentation
- Check `IMPLEMENTATION_SUMMARY.md` for technical details
- Check browser console for error messages
- Check extension service worker console for background errors

## License

Part of the Nimbalyst project. See main repository for license.
