import React, { useState, useRef, useEffect, useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { NewFileType, ExtensionFileType } from './NewFileMenu';

interface FileTypeOption {
  id: NewFileType;
  label: string;
  icon: string;
  extension: string;
  defaultContent?: string;
}

interface FileTreeItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
}

interface NewFileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentDirectory: string;
  workspacePath: string;
  onCreateFile: (fileName: string, fileType: NewFileType) => void;
  /** Extension-contributed file types */
  extensionFileTypes?: ExtensionFileType[];
  /** Callback when directory changes */
  onDirectoryChange?: (directory: string) => void;
}

export const NewFileDialog: React.FC<NewFileDialogProps> = ({
  isOpen,
  onClose,
  currentDirectory,
  workspacePath,
  onCreateFile,
  extensionFileTypes = [],
  onDirectoryChange,
}) => {
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [selectedFileType, setSelectedFileType] = useState<NewFileType>('markdown');
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [fileTree, setFileTree] = useState<FileTreeItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);

  // Load file tree when dialog opens
  useEffect(() => {
    if (!isOpen || !workspacePath || !window.electronAPI?.getFolderContents) return;

    const loadFileTree = async () => {
      try {
        const tree = await window.electronAPI.getFolderContents(workspacePath);
        setFileTree(tree);
      } catch (error) {
        console.error('Error loading file tree:', error);
      }
    };

    loadFileTree();
  }, [isOpen, workspacePath]);

  // Build file type options
  const fileTypeOptions = useMemo<FileTypeOption[]>(() => {
    const options: FileTypeOption[] = [
      { id: 'markdown', label: 'Markdown', icon: 'description', extension: '.md' },
      { id: 'mockup', label: 'Mockup', icon: 'web', extension: '.mockup.html' },
    ];

    // Add extension-contributed types
    extensionFileTypes.forEach((extType) => {
      options.push({
        id: `ext:${extType.extension}`,
        label: extType.displayName,
        icon: extType.icon,
        extension: extType.extension,
        defaultContent: extType.defaultContent,
      });
    });

    // Add "Other" option for any file type
    options.push({ id: 'any', label: 'Other', icon: 'note_add', extension: '' });

    return options;
  }, [extensionFileTypes]);

  // Get the currently selected file type option
  const currentFileType = useMemo(() => {
    return fileTypeOptions.find((opt) => opt.id === selectedFileType) || fileTypeOptions[0];
  }, [fileTypeOptions, selectedFileType]);

  // Compute the extension suffix to display
  const extensionSuffix = useMemo(() => {
    if (selectedFileType === 'any') {
      return ''; // User provides their own extension
    }
    // Check if the user already typed the extension
    const ext = currentFileType.extension;
    if (ext && !fileName.endsWith(ext)) {
      return ext;
    }
    return '';
  }, [selectedFileType, currentFileType, fileName]);

  useEffect(() => {
    if (isOpen) {
      setFileName('');
      setError('');
      setSelectedFileType('markdown');
      setShowFolderPicker(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Close folder picker when clicking outside
  useEffect(() => {
    if (!showFolderPicker) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(event.target as Node)) {
        setShowFolderPicker(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFolderPicker]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!fileName.trim()) {
      setError('Please enter a file name');
      return;
    }

    // Check for invalid characters
    if (fileName.includes('/') || fileName.includes('\\')) {
      setError('File name cannot contain / or \\');
      return;
    }

    onCreateFile(fileName.trim(), selectedFileType);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showFolderPicker) {
        setShowFolderPicker(false);
      } else {
        onClose();
      }
    }
  };

  const handleFolderSelect = (folderPath: string) => {
    onDirectoryChange?.(folderPath);
    setShowFolderPicker(false);
  };

  // Recursively render folder tree for folder picker
  const renderFolderTree = (items: typeof fileTree, level = 0) => {
    const folders = items.filter((item) => item.type === 'directory');
    if (folders.length === 0) return null;

    return (
      <ul
        className="new-file-folder-list list-none m-0 p-0"
        style={{ paddingLeft: level > 0 ? 16 : 0 }}
      >
        {folders.map((folder) => {
          const isSelected = folder.path === currentDirectory;
          return (
            <li key={folder.path}>
              <div
                className={`new-file-folder-item flex items-center gap-2 py-1.5 px-2.5 rounded cursor-pointer text-[13px] ${
                  isSelected
                    ? 'bg-nim-primary text-nim-on-primary'
                    : 'text-nim hover:bg-nim-hover'
                }`}
                onClick={() => handleFolderSelect(folder.path)}
              >
                <MaterialSymbol
                  icon="folder"
                  size={16}
                  className={isSelected ? 'text-nim-on-primary' : 'text-nim-muted'}
                />
                <span>{folder.name}</span>
              </div>
              {folder.children && renderFolderTree(folder.children, level + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  if (!isOpen) return null;

  // Get relative path for display
  const relativePath = currentDirectory.startsWith(workspacePath)
    ? currentDirectory.slice(workspacePath.length + 1) || '/'
    : currentDirectory;

  const workspaceName = workspacePath.split('/').pop() || 'workspace';

  return (
    <div className="new-file-dialog-overlay nim-overlay" onClick={onClose}>
      <div
        className="new-file-dialog w-[420px] max-w-[90vw] p-6 rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.3)] bg-nim border border-nim"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="m-0 mb-5 text-lg font-semibold text-nim">
          New File
        </h2>

        {/* File Type Selector */}
        <div className="new-file-field mb-4">
          <label className="block mb-1.5 text-[13px] font-medium text-nim-muted">
            Type
          </label>
          <select
            value={selectedFileType}
            onChange={(e) => {
              setSelectedFileType(e.target.value as NewFileType);
              setError('');
            }}
            className="new-file-select w-full py-2 px-3 pr-8 text-sm rounded cursor-pointer appearance-none focus:outline-none bg-nim-secondary border border-nim text-nim bg-[url('data:image/svg+xml,%3Csvg_xmlns=%27http://www.w3.org/2000/svg%27_width=%2712%27_height=%2712%27_viewBox=%270_0_12_12%27%3E%3Cpath_fill=%27%23969696%27_d=%27M3_4.5L6_7.5L9_4.5%27/%3E%3C/svg%3E')] bg-no-repeat bg-[right_12px_center]"
          >
            {fileTypeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Location Selector */}
        <div className="new-file-field mb-4">
          <label className="block mb-1.5 text-[13px] font-medium text-nim-muted">
            Location
          </label>
          <div className="new-file-location-picker relative" ref={folderPickerRef}>
            <button
              type="button"
              className="new-file-location-button w-full flex items-center gap-2 py-2 px-3 text-sm rounded cursor-pointer text-left focus:outline-none bg-nim-secondary border border-nim text-nim"
              onClick={() => setShowFolderPicker(!showFolderPicker)}
            >
              <MaterialSymbol icon="folder" size={16} />
              <span className="path flex-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                {relativePath}
              </span>
              <MaterialSymbol icon="expand_more" size={16} className="text-nim-faint" />
            </button>
            {showFolderPicker && fileTree.length > 0 && (
              <div className="new-file-folder-picker absolute top-[calc(100%+4px)] left-0 right-0 max-h-[250px] overflow-y-auto p-1 rounded z-[10001] shadow-[0_4px_12px_rgba(0,0,0,0.3)] bg-nim border border-nim">
                <div
                  className={`new-file-folder-item flex items-center gap-2 py-1.5 px-2.5 rounded cursor-pointer text-[13px] ${
                    currentDirectory === workspacePath
                      ? 'bg-nim-primary text-nim-on-primary'
                      : 'text-nim hover:bg-nim-hover'
                  }`}
                  onClick={() => handleFolderSelect(workspacePath)}
                >
                  <MaterialSymbol
                    icon="folder"
                    size={16}
                    className={currentDirectory === workspacePath ? 'text-nim-on-primary' : 'text-nim-muted'}
                  />
                  <span>{workspaceName} (root)</span>
                </div>
                {renderFolderTree(fileTree)}
              </div>
            )}
          </div>
        </div>

        {/* File Name Input */}
        <form onSubmit={handleSubmit}>
          <div className="new-file-field mb-4">
            <label className="block mb-1.5 text-[13px] font-medium text-nim-muted">
              Name
            </label>
            <div className="new-file-input-wrapper flex items-center overflow-hidden rounded bg-nim-secondary border border-nim focus-within:border-nim-focus">
              <input
                ref={inputRef}
                type="text"
                value={fileName}
                onChange={(e) => {
                  setFileName(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder={selectedFileType === 'any' ? 'document.txt' : 'document'}
                className="new-file-input flex-1 py-2 px-3 text-sm bg-transparent border-none focus:outline-none text-nim placeholder:text-nim-faint"
              />
              {extensionSuffix && (
                <span className="new-file-extension py-2 pr-3 text-sm font-mono select-none text-nim-faint">
                  {extensionSuffix}
                </span>
              )}
            </div>
          </div>
          {error && (
            <div className="new-file-error text-[13px] mb-4 text-nim-error">{error}</div>
          )}
          <div className="new-file-buttons flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={onClose}
              className="py-1.5 px-4 text-[13px] rounded cursor-pointer transition-colors duration-200 bg-nim-secondary border border-nim text-nim hover:bg-nim-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="py-1.5 px-4 text-[13px] rounded cursor-pointer transition-colors duration-200 bg-nim-primary border border-nim-primary text-nim-on-primary hover:bg-nim-primary-hover"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
