/**
 * Popup UI script for Nimbalyst Web Clipper
 */

// DOM elements
const clipPageBtn = document.getElementById('clipPageBtn');
const clipSelectionBtn = document.getElementById('clipSelectionBtn');
const statusMessage = document.getElementById('statusMessage');
const pageTitle = document.getElementById('pageTitle');

// State
let currentTab = null;
let pageData = null;

/**
 * Initialize popup
 */
async function init() {
  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    // Update page title
    pageTitle.textContent = tab.title;

    // Get page data from content script
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getMarkdown' });

    if (response.success) {
      pageData = response;

      // Enable clip selection button if there's a selection
      if (response.selection) {
        clipSelectionBtn.disabled = false;
      }
    } else {
      showStatus('error', 'Failed to load page content');
    }
  } catch (error) {
    console.error('Error initializing popup:', error);
    showStatus('error', 'Error loading page. Try refreshing.');
  }
}

/**
 * Show status message
 */
function showStatus(type, message) {
  statusMessage.className = `status-message ${type}`;
  statusMessage.textContent = message;

  if (type === 'success') {
    setTimeout(() => {
      statusMessage.className = 'status-message';
    }, 3000);
  }
}

/**
 * Clip full page
 */
async function clipPage() {
  if (!pageData) return;

  try {
    clipPageBtn.disabled = true;
    showStatus('info', 'Clipping page...');

    const response = await chrome.runtime.sendMessage({
      action: 'clipPage',
      data: {
        title: pageData.metadata.title,
        url: pageData.metadata.url,
        content: pageData.markdown,
        selection: null,
      },
    });

    if (response.success) {
      showStatus('success', 'Page clipped to Nimbalyst!');
      setTimeout(() => window.close(), 1500);
    } else {
      showStatus('error', response.error || 'Failed to clip page');
      clipPageBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error clipping page:', error);
    showStatus('error', 'Error clipping page');
    clipPageBtn.disabled = false;
  }
}

/**
 * Clip selection
 */
async function clipSelection() {
  if (!pageData || !pageData.selection) return;

  try {
    clipSelectionBtn.disabled = true;
    showStatus('info', 'Clipping selection...');

    const response = await chrome.runtime.sendMessage({
      action: 'clipPage',
      data: {
        title: pageData.metadata.title,
        url: pageData.metadata.url,
        content: pageData.markdown,
        selection: pageData.selection,
      },
    });

    if (response.success) {
      showStatus('success', 'Selection clipped to Nimbalyst!');
      setTimeout(() => window.close(), 1500);
    } else {
      showStatus('error', response.error || 'Failed to clip selection');
      clipSelectionBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error clipping selection:', error);
    showStatus('error', 'Error clipping selection');
    clipSelectionBtn.disabled = false;
  }
}

// Event listeners
clipPageBtn.addEventListener('click', clipPage);
clipSelectionBtn.addEventListener('click', clipSelection);

// Initialize on load
init();
