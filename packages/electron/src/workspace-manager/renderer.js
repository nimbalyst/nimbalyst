const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let recentWorkspaces = [];
let selectedWorkspace = null;

// Initialize
async function init() {
  // Apply theme
  const theme = await ipcRenderer.invoke('get-theme');
  applyTheme(theme);

  // Load recent workspaces
  await loadRecentWorkspaces();

  // Listen for theme changes
  ipcRenderer.on('theme-change', (event, theme) => {
    applyTheme(theme);
  });
}

// Apply theme
function applyTheme(theme) {
  // Guard: avoid redundant re-apply
  if (document.body.dataset.theme === theme) return;
  document.body.dataset.theme = theme;
  if (theme === 'dark' || theme === 'crystal-dark') {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
}

// Load recent workspaces
async function loadRecentWorkspaces() {
  try {
    recentWorkspaces = await ipcRenderer.invoke('workspace-manager:get-recent-workspaces');
    renderWorkspaceList();
  } catch (error) {
    console.error('Failed to load recent workspaces:', error);
  }
}

// Render workspace list
function renderWorkspaceList() {
  const container = document.getElementById('workspaceList');

  if (recentWorkspaces.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: #9ca3af;">
        <p style="font-size: 14px;">No recent workspaces</p>
        <p style="font-size: 12px; margin-top: 8px;">Open a folder to get started</p>
      </div>
    `;
    return;
  }

  container.innerHTML = recentWorkspaces.map(workspace => {
    const isSelected = selectedWorkspace && selectedWorkspace.path === workspace.path;
    const lastModified = workspace.lastModified ? formatDate(workspace.lastModified) : 'Unknown';
    const fileCount = workspace.fileCount || 0;
    const warning = workspace.limited ? ' <span style="color: #f59e0b;" title="Large workspace - file count is approximate">⚠️</span>' : '';

    return `
      <div class="workspace-item ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(workspace.path)}">
        <div class="workspace-name">${escapeHtml(workspace.name)}${warning}</div>
        <div class="workspace-path">${escapeHtml(workspace.path)}</div>
        <div class="workspace-meta">
          <span>${fileCount} files</span>
          <span>•</span>
          <span>${lastModified}</span>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.workspace-item').forEach(item => {
    item.addEventListener('click', () => {
      const workspacePath = item.dataset.path;
      const workspace = recentWorkspaces.find(w => w.path === workspacePath);
      if (workspace) {
        selectWorkspace(workspace);
      }
    });
  });
}

// Select a workspace
async function selectWorkspace(workspace) {
  selectedWorkspace = workspace;

  // Update UI
  document.querySelectorAll('.workspace-item').forEach(item => {
    item.classList.remove('selected');
    if (item.dataset.path === workspace.path) {
      item.classList.add('selected');
    }
  });

  // Get workspace stats
  const stats = await getWorkspaceStats(workspace.path);

  // Show workspace preview
  showWorkspacePreview(workspace, stats);
}

// Get workspace statistics
async function getWorkspaceStats(workspacePath) {
  try {
    const stats = await ipcRenderer.invoke('workspace-manager:get-workspace-stats', workspacePath);
    return stats;
  } catch (error) {
    console.error('Failed to get workspace stats:', error);
    return {
      fileCount: 0,
      totalSize: 0,
      recentFiles: []
    };
  }
}

// Show workspace preview
function showWorkspacePreview(workspace, stats) {
  const rightPanel = document.getElementById('rightPanel');

  // Format file size
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  rightPanel.innerHTML = `
    <div class="workspace-preview">
      <div class="preview-header">
        <div>
          <h2 class="preview-title">${escapeHtml(workspace.name)}</h2>
          <p class="preview-path">${escapeHtml(workspace.path)}</p>
        </div>
        <button class="remove-btn" onclick="removeFromRecent('${escapeHtml(workspace.path)}')" title="Remove from recent">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </button>
      </div>

      ${stats.limited ? `
        <div style="padding: 12px; background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #92400e;">
          <strong>⚠️ Large Workspace</strong><br>
          This workspace contains many files. File counts shown are approximate. The workspace will still open normally.
        </div>
      ` : ''}

      <div class="preview-stats">
        <div class="stat-item">
          <div class="stat-value">${stats.fileCount || 0}</div>
          <div class="stat-label">Files</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${stats.markdownCount || 0}</div>
          <div class="stat-label">Markdown</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${formatSize(stats.totalSize || 0)}</div>
          <div class="stat-label">Size</div>
        </div>
      </div>
      
      ${stats.recentFiles && stats.recentFiles.length > 0 ? `
        <div style="margin-bottom: 24px;">
          <div class="section-title" style="margin-bottom: 12px;">Recent Files</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${stats.recentFiles.slice(0, 5).map(file => `
              <div style="padding: 8px 12px; background: #f9fafb; border-radius: 6px; font-size: 13px; color: #374151;">
                ${escapeHtml(path.basename(file))}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      
      <div class="preview-actions">
        <button class="btn btn-primary" onclick="openWorkspace('${escapeHtml(workspace.path)}')">
          Open Workspace
        </button>
      </div>
    </div>
  `;
}

// Open folder dialog
async function openFolder() {
  try {
    const result = await ipcRenderer.invoke('workspace-manager:open-folder-dialog');
    if (result.success && result.path) {
      await openWorkspace(result.path);
    }
  } catch (error) {
    console.error('Failed to open folder:', error);
  }
}

// Create new workspace
async function createNewWorkspace() {
  try {
    const result = await ipcRenderer.invoke('workspace-manager:create-workspace-dialog');
    if (result.success && result.path) {
      await openWorkspace(result.path);
    }
  } catch (error) {
    console.error('Failed to create workspace:', error);
  }
}

// Open workspace (always in new window)
async function openWorkspace(workspacePath) {
  try {
    await ipcRenderer.invoke('workspace-manager:open-workspace', workspacePath);
    // Close the workspace manager after opening
    window.close();
  } catch (error) {
    console.error('Failed to open workspace:', error);
  }
}

// Remove from recent
async function removeFromRecent(workspacePath) {
  if (!confirm('Remove this workspace from recent workspaces?')) {
    return;
  }

  try {
    await ipcRenderer.invoke('workspace-manager:remove-recent', workspacePath);
    await loadRecentWorkspaces();

    // Clear preview if this was selected
    if (selectedWorkspace && selectedWorkspace.path === workspacePath) {
      selectedWorkspace = null;
      document.getElementById('rightPanel').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24">
              <path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/>
            </svg>
          </div>
          <h2 class="empty-title">Workspace Removed</h2>
          <p class="empty-description">Select another workspace from the list or open a new folder.</p>
        </div>
      `;
    }
  } catch (error) {
    console.error('Failed to remove from recent:', error);
  }
}

// Format date
function formatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return mins <= 1 ? 'Just now' : `${mins} mins ago`;
  }

  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }

  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }

  return date.toLocaleDateString();
}

// Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Make functions available globally
window.openFolder = openFolder;
window.createNewWorkspace = createNewWorkspace;
window.openWorkspace = openWorkspace;
window.removeFromRecent = removeFromRecent;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
