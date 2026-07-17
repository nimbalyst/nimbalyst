/**
 * MockupPickerMenu - A typeahead submenu for selecting or creating mockups.
 *
 * This appears as a floating menu when user selects "Mockup" from the component picker.
 * Shows "New Mockup" at top + list of existing mockups.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getMockupPlatformService,
  hasMockupPlatformService,
  generateMockupScreenshot,
  INSERT_MOCKUP_COMMAND,
  type MockupFileInfo,
  type MockupPayload,
} from '@nimbalyst/runtime';
import { $getRoot } from 'lexical';
import type { LexicalEditor } from 'lexical';

interface MockupPickerMenuProps {
  onClose: () => void;
}

// Singleton state for the picker
let showPickerCallback: ((props: MockupPickerMenuProps) => void) | null = null;
let hidePickerCallback: (() => void) | null = null;

/**
 * Show the mockup picker menu.
 * Called by the MockupPlugin when INSERT_MOCKUP_COMMAND is dispatched without payload.
 */
export function showMockupPickerMenu(): void {
  if (showPickerCallback) {
    showPickerCallback({ onClose: () => hidePickerCallback?.() });
  } else {
    console.warn('[MockupPickerMenu] Picker not mounted');
  }
}

/**
 * MockupPickerMenuHost - Renders the picker when triggered.
 * Mount this once in your app to enable the mockup picker.
 */
export function MockupPickerMenuHost(): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const [props, setProps] = useState<MockupPickerMenuProps | null>(null);

  useEffect(() => {
    showPickerCallback = (p) => {
      setProps(p);
      setIsOpen(true);
    };
    hidePickerCallback = () => {
      setIsOpen(false);
      setProps(null);
    };

    return () => {
      showPickerCallback = null;
      hidePickerCallback = null;
    };
  }, []);

  if (!isOpen || !props) {
    return null;
  }

  return <MockupPickerMenu onClose={props.onClose} />;
}

function MockupPickerMenu({ onClose }: MockupPickerMenuProps): JSX.Element {
  const [mockups, setMockups] = useState<MockupFileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load mockup files
  useEffect(() => {
    async function loadMockups() {
      if (!hasMockupPlatformService()) {
        setIsLoading(false);
        return;
      }

      try {
        const service = getMockupPlatformService();
        const files = await service.listMockupFiles();
        setMockups(files);
      } catch (error) {
        console.error('[MockupPickerMenu] Failed to load mockups:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadMockups();
  }, []);

  // Focus input on initial mount
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // Focus input when switching between search and create modes
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [isCreatingNew]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Filter mockups by search
  const filteredMockups = mockups.filter(
    (wf) =>
      wf.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      wf.relativePath.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Options: "New Mockup" + filtered mockups
  const options = [
    { id: 'new', label: '+ New Mockup', isNew: true },
    ...filteredMockups.map((wf) => ({
      id: wf.absolutePath,
      label: wf.name,
      description: wf.relativePath,
      isNew: false,
      mockup: wf,
    })),
  ];

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isCreatingNew) {
        if (e.key === 'Escape') {
          setIsCreatingNew(false);
          setNewName('');
        } else if (e.key === 'Enter' && newName.trim()) {
          handleCreateNew(newName.trim());
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, options.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          handleSelect(options[selectedIndex]);
          break;
        case 'Escape':
          onClose();
          break;
      }
    },
    [options, selectedIndex, isCreatingNew, newName, onClose]
  );

  // Handle selection
  const handleSelect = useCallback(
    (option: (typeof options)[0]) => {
      if (option.isNew) {
        setIsCreatingNew(true);
      } else if ('mockup' in option && option.mockup) {
        handleInsertExisting(option.mockup);
      }
    },
    []
  );

  // Create new mockup
  async function handleCreateNew(name: string) {
    if (!hasMockupPlatformService()) return;

    const documentPath = (window as any).__currentDocumentPath;
    if (!documentPath) {
      console.warn('[MockupPickerMenu] No document open');
      onClose();
      return;
    }

    try {
      const service = getMockupPlatformService();
      const documentDir = documentPath.substring(0, documentPath.lastIndexOf('/'));
      const mockupPath = await service.createMockupFile(name, documentDir);
      const relativeMockupPath = service.getRelativePath(documentPath, mockupPath);

      // Insert node immediately with empty screenshot (shows loading state)
      dispatchInsertCommand({
        mockupPath: relativeMockupPath,
        screenshotPath: '', // Empty - will show loading state
        altText: name,
      });

      // Close menu immediately for snappy UX
      onClose();

      // Open for editing
      service.openMockupEditor(mockupPath);

      // Generate screenshot in background and update node
      generateMockupScreenshot(mockupPath, documentPath).then(({ screenshotPath }: { screenshotPath: string }) => {
        updateNodeScreenshotByPath(relativeMockupPath, screenshotPath);
      }).catch((error: Error) => {
        console.error('[MockupPickerMenu] Failed to generate screenshot:', error);
        // Even if screenshot generation fails, set an expected path so the image can load if it exists
        const expectedScreenshotPath = `assets/${name}.mockup.png`;
        updateNodeScreenshotByPath(relativeMockupPath, expectedScreenshotPath);
      });
    } catch (error) {
      console.error('[MockupPickerMenu] Failed to create mockup:', error);
    }
  }

  // Insert existing mockup
  async function handleInsertExisting(mockup: MockupFileInfo) {
    if (!hasMockupPlatformService()) return;

    const documentPath = (window as any).__currentDocumentPath;
    if (!documentPath) {
      console.warn('[MockupPickerMenu] No document open');
      onClose();
      return;
    }

    try {
      const service = getMockupPlatformService();
      const relativeMockupPath = service.getRelativePath(documentPath, mockup.absolutePath);

      // Insert node immediately with empty screenshot (shows loading state)
      dispatchInsertCommand({
        mockupPath: relativeMockupPath,
        screenshotPath: '', // Empty - will show loading state
        altText: mockup.name,
      });

      // Close menu immediately for snappy UX
      onClose();

      // Generate screenshot in background and update node
      generateMockupScreenshot(mockup.absolutePath, documentPath).then(({ screenshotPath }: { screenshotPath: string }) => {
        updateNodeScreenshotByPath(relativeMockupPath, screenshotPath);
      }).catch((error: Error) => {
        console.error('[MockupPickerMenu] Failed to generate screenshot:', error);
        // Even if screenshot generation fails, check if an existing screenshot exists
        // and update the node with a placeholder or error state
        const expectedScreenshotPath = `assets/${mockup.name}.mockup.png`;
        updateNodeScreenshotByPath(relativeMockupPath, expectedScreenshotPath);
      });
    } catch (error) {
      console.error('[MockupPickerMenu] Failed to insert mockup:', error);
    }
  }

  // Get the editor instance for the current document
  function getEditor(): LexicalEditor | null {
    const documentPath = (window as any).__currentDocumentPath;
    const editorRegistry = (window as any).__editorRegistry;
    if (editorRegistry && documentPath) {
      const editorInstance = editorRegistry.getEditor(documentPath);
      return editorInstance?.editor || null;
    }
    return null;
  }

  // Insert mockup node into the active editor
  // Returns a function that can be called later to find the node key
  function dispatchInsertCommand(payload: { mockupPath: string; screenshotPath: string; altText: string }): string | null {
    const editor = getEditor();
    if (!editor) return null;

    // Dispatch the command to insert the node
    editor.dispatchCommand(INSERT_MOCKUP_COMMAND, payload as MockupPayload);

    // The node key will be found asynchronously after the editor updates
    // We return the mockupPath as identifier since it's unique
    return payload.mockupPath;
  }

  // Find the mockup node by mockupPath and update its screenshot
  function updateNodeScreenshotByPath(mockupPath: string, screenshotPath: string) {
    const editor = getEditor();
    if (!editor) {
      console.warn('[MockupPickerMenu] No editor found for update');
      return;
    }

    console.log('[MockupPickerMenu] Attempting to update node with mockupPath:', mockupPath);

    editor.update(() => {
      const root = $getRoot();
      let found = false;
      const findAndUpdate = (node: { getType: () => string; getMockupPath?: () => string; setScreenshotPath?: (path: string) => void; getChildren?: () => { getType: () => string; getMockupPath?: () => string; setScreenshotPath?: (path: string) => void }[] }) => {
        if (node.getType() === 'mockup') {
          const nodePath = node.getMockupPath ? node.getMockupPath() : 'N/A';
          console.log('[MockupPickerMenu] Found mockup node with path:', nodePath);
          if (node.getMockupPath && node.getMockupPath() === mockupPath) {
            if (node.setScreenshotPath) {
              console.log('[MockupPickerMenu] Updating screenshot for:', mockupPath, '->', screenshotPath);
              node.setScreenshotPath(screenshotPath);
              found = true;
            }
            return true;
          }
        }
        if (node.getChildren) {
          for (const child of node.getChildren()) {
            if (findAndUpdate(child)) return true;
          }
        }
        return false;
      };
      root.getChildren().forEach(findAndUpdate);
      if (!found) {
        console.warn('[MockupPickerMenu] Could not find mockup node with mockupPath:', mockupPath);
      }
    });
  }

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  return (
    <div className="mockup-picker-overlay fixed inset-0 z-[1000] flex items-start justify-center pt-[20vh]">
      <div
        ref={menuRef}
        className="mockup-picker-menu flex flex-col overflow-hidden w-80 max-h-[400px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_4px_20px_rgba(0,0,0,0.15)]"
        onKeyDown={handleKeyDown}
      >
        {isCreatingNew ? (
          <div className="mockup-picker-create p-2">
            <input
              ref={inputRef}
              type="text"
              className="mockup-picker-input w-full px-4 py-3 border-none border-b border-b-[var(--nim-border)] text-sm bg-transparent text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)]"
              placeholder="Enter mockup name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <div className="mockup-picker-create-hint px-3 py-2 text-xs text-[var(--nim-text-faint)]">
              Press Enter to create, Escape to cancel
            </div>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              type="text"
              className="mockup-picker-input w-full px-4 py-3 border-none border-b border-b-[var(--nim-border)] text-sm bg-transparent text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)]"
              placeholder="Search mockups..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="mockup-picker-list flex-1 overflow-y-auto p-1">
              {isLoading ? (
                <div className="mockup-picker-loading p-4 text-center text-sm text-[var(--nim-text-muted)]">
                  Loading...
                </div>
              ) : (
                options.map((option, index) => (
                  <div
                    key={option.id}
                    className={`mockup-picker-item flex flex-col gap-0.5 px-3 py-2 rounded cursor-pointer text-[var(--nim-text)] ${
                      index === selectedIndex ? 'selected bg-[var(--nim-bg-hover)]' : ''
                    } ${
                      option.isNew
                        ? 'new-item text-[var(--nim-primary)] font-medium border-b border-b-[var(--nim-border)] mb-1 rounded-t rounded-b-none'
                        : 'hover:bg-[var(--nim-bg-hover)]'
                    }`}
                    onClick={() => handleSelect(option)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="mockup-picker-item-label text-sm">{option.label}</span>
                    {'description' in option && option.description && (
                      <span className="mockup-picker-item-desc text-xs text-[var(--nim-text-faint)] overflow-hidden text-ellipsis whitespace-nowrap">
                        {option.description}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
