/**
 * Background service worker for Nimbalyst Web Clipper
 * Handles context menus, message routing, and sending clips to Nimbalyst
 */

/**
 * Initialize context menus on installation
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'clip-page',
    title: 'Clip page to Nimbalyst',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id: 'clip-selection',
    title: 'Clip selection to Nimbalyst',
    contexts: ['selection'],
  });

  console.log('Nimbalyst Web Clipper installed');
});

/**
 * Send clip to Nimbalyst via its local HTTP server.
 * Tries ports 3456-3465 to find the running MCP server.
 */
async function sendClipToNimbalyst(clipData) {
  const startPort = 3456;
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`http://127.0.0.1:${port}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clipData),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Any JSON response from /clip means we found Nimbalyst
      const result = await response.json().catch(() => null);

      if (response.ok) {
        console.log(`Clip sent to Nimbalyst on port ${port}:`, result?.path);
        return { success: true };
      } else {
        // Server responded but with an error
        console.error(`Nimbalyst responded with error on port ${port}:`, result);
        return { success: false, error: result?.error || `Server error: ${response.status}` };
      }
    } catch {
      // Port not available or timeout, try next
    }
  }

  console.error('Could not connect to Nimbalyst. Is it running?');
  return { success: false, error: 'Could not connect to Nimbalyst. Is it running?' };
}

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: info.selectionText ? 'getSelection' : 'getMarkdown',
    });

    if (!response.success) {
      console.error('Failed to get page content:', response.error);
      return;
    }

    const { markdown, metadata, selection } = response;

    if (info.menuItemId === 'clip-page') {
      await sendClipToNimbalyst({
        title: metadata.title,
        url: metadata.url,
        content: markdown,
        selection: null,
      });
    } else if (info.menuItemId === 'clip-selection') {
      await sendClipToNimbalyst({
        title: metadata.title,
        url: metadata.url,
        content: markdown,
        selection: selection || info.selectionText,
      });
    }
  } catch (error) {
    console.error('Error handling context menu click:', error);
  }
});

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'clipPage') {
    sendClipToNimbalyst(request.data)
      .then(sendResponse)
      .catch((error) => {
        console.error('Error clipping page:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

console.log('Nimbalyst Web Clipper background service worker loaded');
