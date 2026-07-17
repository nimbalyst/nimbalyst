/**
 * DataModelPickerMenu - A typeahead submenu for selecting or creating data models.
 *
 * This appears as a floating menu when user selects "Data Model" from the component picker.
 * Shows "New Data Model" at top + list of existing .prisma files.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCommand } from 'lexical';
import type { LexicalCommand } from 'lexical';

import {
  getDataModelPlatformService,
  hasDataModelPlatformService,
  type DataModelFileInfo,
} from './DataModelPlatformService';
import { $createDataModelNode, type DataModelPayload } from './DataModelNode';

// Get host's Lexical module for editor operations
// This ensures we use the same Lexical instance as the host editor
function getHostLexical() {
  const hostExtensions = (window as any).__nimbalyst_extensions;
  return hostExtensions?.lexical || null;
}

import './DataModelPickerMenu.css';

/**
 * Command to insert a data model into the editor.
 * If called with payload (dataModelPath + screenshotPath), inserts directly.
 * If called without payload, shows the data model picker UI.
 */
export const INSERT_DATAMODEL_COMMAND: LexicalCommand<DataModelPayload | undefined> =
  createCommand('INSERT_DATAMODEL_COMMAND');

interface DataModelPickerMenuProps {
  onClose: () => void;
}

// Singleton state for the picker
let showPickerCallback: ((props: DataModelPickerMenuProps) => void) | null = null;
let hidePickerCallback: (() => void) | null = null;

/**
 * Show the data model picker menu.
 * Called by the extension when INSERT_DATAMODEL_COMMAND is dispatched without payload.
 */
export function showDataModelPickerMenu(): void {
  if (showPickerCallback) {
    showPickerCallback({ onClose: () => hidePickerCallback?.() });
  } else {
    console.warn('[DataModelPickerMenu] Picker not mounted');
  }
}

/**
 * DataModelPickerMenuHost - Renders the picker when triggered.
 * Mount this once in your app to enable the data model picker.
 */
export function DataModelPickerMenuHost(): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const [props, setProps] = useState<DataModelPickerMenuProps | null>(null);

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

  return <DataModelPickerMenu onClose={props.onClose} />;
}

function DataModelPickerMenu({ onClose }: DataModelPickerMenuProps): JSX.Element {
  const [dataModels, setDataModels] = useState<DataModelFileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load data model files
  useEffect(() => {
    async function loadDataModels() {
      if (!hasDataModelPlatformService()) {
        setIsLoading(false);
        return;
      }

      try {
        const service = getDataModelPlatformService();
        const files = await service.listDataModelFiles();
        setDataModels(files);
      } catch (error) {
        console.error('[DataModelPickerMenu] Failed to load data models:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadDataModels();
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

  // Filter data models by search
  const filteredDataModels = dataModels.filter(
    (dm) =>
      dm.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      dm.relativePath.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Options: "New Data Model" + filtered data models
  const options = [
    { id: 'new', label: '+ New Data Model', isNew: true },
    ...filteredDataModels.map((dm) => ({
      id: dm.absolutePath,
      label: dm.name,
      description: dm.relativePath,
      isNew: false,
      dataModel: dm,
    })),
  ];

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isCreatingNew) {
        if (event.key === 'Escape') {
          setIsCreatingNew(false);
          setNewName('');
        } else if (event.key === 'Enter' && newName.trim()) {
          handleCreateNew();
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, options.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          event.preventDefault();
          const selected = options[selectedIndex];
          if (selected) {
            handleSelect(selected);
          }
          break;
        case 'Escape':
          onClose();
          break;
      }
    },
    [options, selectedIndex, isCreatingNew, newName, onClose]
  );

  // Handle option selection
  const handleSelect = useCallback(
    (option: (typeof options)[number]) => {
      if (option.isNew) {
        setIsCreatingNew(true);
      } else if ('dataModel' in option && option.dataModel) {
        insertDataModel(option.dataModel);
      }
    },
    []
  );

  // Insert a data model node
  const insertDataModel = useCallback(
    async (dataModel: DataModelFileInfo) => {
      if (!hasDataModelPlatformService()) {
        console.warn('[DataModelPickerMenu] Platform service not available');
        return;
      }

      const service = getDataModelPlatformService();
      const documentPath = (window as any).__currentDocumentPath;

      if (!documentPath) {
        console.warn('[DataModelPickerMenu] No current document path');
        return;
      }

      // Get relative path from document to data model
      const relativePath = service.getRelativePath(documentPath, dataModel.absolutePath);

      // Close the menu immediately for snappy UX
      onClose();

      // Insert the node with empty screenshot (will show loading state)
      // The screenshot will be generated in the background
      const editorRegistry = (window as any).__editorRegistry;
      if (editorRegistry) {
        // We need to dispatch a command to insert the node
        // For now, we'll use the global editorRegistry to get the active editor
        const activeFilePath = (window as any).__currentDocumentPath;
        const editorInstance = editorRegistry.getEditor(activeFilePath);
        const editor = editorInstance?.editor;

        if (editor) {
          // Use host's Lexical functions for proper context
          const hostLexical = getHostLexical();
          if (!hostLexical) {
            console.error('[DataModelPickerMenu] Host Lexical not available');
            return;
          }

          editor.update(() => {
            const dataModelNode = $createDataModelNode({
              dataModelPath: relativePath,
              screenshotPath: '', // Empty - will show loading state
              altText: dataModel.name.replace('.prisma', ''),
            });
            hostLexical.$insertNodes([dataModelNode]);
          });

          // Generate screenshot in background
          generateScreenshotInBackground(
            dataModel.absolutePath,
            relativePath,
            documentPath,
            editor
          );
        }
      }
    },
    [onClose]
  );

  // Generate screenshot in background and update the node
  const generateScreenshotInBackground = async (
    absoluteDataModelPath: string,
    relativeDataModelPath: string,
    documentPath: string,
    editor: any
  ) => {
    if (!hasDataModelPlatformService()) return;

    try {
      const service = getDataModelPlatformService();

      // Determine screenshot path
      const dataModelName = absoluteDataModelPath
        .split('/')
        .pop()
        ?.replace('.prisma', '') || 'datamodel';
      const documentDir = documentPath.substring(0, documentPath.lastIndexOf('/'));
      const assetsDir = `${documentDir}/assets`;
      const screenshotFilename = `${dataModelName}.prisma.png`;
      const absoluteScreenshotPath = `${assetsDir}/${screenshotFilename}`;
      const relativeScreenshotPath = `assets/${screenshotFilename}`;

      // Capture the screenshot
      await service.captureScreenshot(absoluteDataModelPath, absoluteScreenshotPath);

      // Update the node with the screenshot path
      const hostLexical = getHostLexical();
      if (!hostLexical) {
        console.error('[DataModelPickerMenu] Host Lexical not available for screenshot update');
        return;
      }

      editor.update(() => {
        const root = hostLexical.$getRoot();
        const descendants = root.getChildren();

        // Find the data model node and update its screenshot path
        function findAndUpdateNode(nodes: any[]) {
          for (const node of nodes) {
            if (
              node.getType?.() === 'datamodel' &&
              node.getDataModelPath?.() === relativeDataModelPath &&
              !node.getScreenshotPath?.()
            ) {
              node.setScreenshotPath(relativeScreenshotPath);
              return true;
            }
            if (node.getChildren) {
              if (findAndUpdateNode(node.getChildren())) {
                return true;
              }
            }
          }
          return false;
        }

        findAndUpdateNode(descendants);
      });
    } catch (error) {
      console.error('[DataModelPickerMenu] Failed to generate screenshot:', error);
    }
  };

  // Handle creating a new data model
  const handleCreateNew = useCallback(async () => {
    if (!newName.trim() || !hasDataModelPlatformService()) return;

    const service = getDataModelPlatformService();
    const documentPath = (window as any).__currentDocumentPath;

    if (!documentPath) {
      console.warn('[DataModelPickerMenu] No current document path');
      return;
    }

    try {
      // Create in the same directory as the document
      const documentDir = documentPath.substring(0, documentPath.lastIndexOf('/'));
      const absolutePath = await service.createDataModelFile(newName.trim(), documentDir);

      // Get the file info for the new data model
      const dataModel: DataModelFileInfo = {
        absolutePath,
        relativePath: absolutePath.split('/').pop() || newName + '.prisma',
        name: newName.trim() + '.prisma',
      };

      // Insert and open the new data model
      await insertDataModel(dataModel);

      // Open the data model for editing
      service.openDataModelEditor(absolutePath);
    } catch (error) {
      console.error('[DataModelPickerMenu] Failed to create data model:', error);
    }
  }, [newName, insertDataModel]);

  return (
    <div
      ref={menuRef}
      className="datamodel-picker-menu"
      onKeyDown={handleKeyDown}
    >
      <div className="datamodel-picker-header">
        {isCreatingNew ? (
          <>
            <input
              ref={inputRef}
              type="text"
              className="datamodel-picker-input"
              placeholder="Enter data model name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <span className="datamodel-picker-hint">
              Press Enter to create, Escape to cancel
            </span>
          </>
        ) : (
          <input
            ref={inputRef}
            type="text"
            className="datamodel-picker-input"
            placeholder="Search data models..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
        )}
      </div>

      {!isCreatingNew && (
        <div className="datamodel-picker-list">
          {isLoading ? (
            <div className="datamodel-picker-loading">Loading...</div>
          ) : (
            options.map((option, index) => (
              <div
                key={option.id}
                className={`datamodel-picker-item ${
                  index === selectedIndex ? 'selected' : ''
                } ${option.isNew ? 'new-item' : ''}`}
                onClick={() => handleSelect(option)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="datamodel-picker-item-icon">
                  {option.isNew ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <ellipse cx="12" cy="5" rx="9" ry="3" />
                      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                    </svg>
                  )}
                </span>
                <span className="datamodel-picker-item-label">{option.label}</span>
                {'description' in option && option.description && (
                  <span className="datamodel-picker-item-description">
                    {option.description}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default DataModelPickerMenu;
