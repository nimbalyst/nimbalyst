import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface ProjectItem {
  path: string;
  name: string;
  lastOpened?: number;
  isOpen: boolean;
  isCurrent: boolean;
}

interface ProjectQuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  currentWorkspacePath: string | null;
}

export const ProjectQuickOpen: React.FC<ProjectQuickOpenProps> = ({
  isOpen,
  onClose,
  currentWorkspacePath,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsListRef = useRef<HTMLUListElement>(null);

  // Load projects when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const loadProjects = async () => {
      const [recentWorkspaces, openPaths] = await Promise.all([
        window.electronAPI.workspaceManager.getRecentWorkspaces(),
        window.electronAPI.workspaceManager.getOpenWorkspaces(),
      ]);

      const openSet = new Set(openPaths);

      const items: ProjectItem[] = recentWorkspaces.map((ws: any) => ({
        path: ws.path,
        name: ws.name || ws.path.split('/').pop() || ws.path,
        lastOpened: ws.lastOpened || ws.timestamp,
        isOpen: openSet.has(ws.path),
        isCurrent: ws.path === currentWorkspacePath,
      }));

      // Sort: current first, then open projects, then by lastOpened
      items.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        return (b.lastOpened || 0) - (a.lastOpened || 0);
      });

      setProjects(items);
    };

    loadProjects();
  }, [isOpen, currentWorkspacePath]);

  // Filter by search query
  const displayProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query)
    );
  }, [searchQuery, projects]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setMouseHasMoved(false);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Track mouse movement
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsListRef.current) return;
    const items = resultsListRef.current.querySelectorAll('.project-quick-open-item');
    const selectedItem = items[selectedIndex] as HTMLElement;
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < displayProjects.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayProjects[selectedIndex]) {
            handleProjectSelect(displayProjects[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, displayProjects, onClose]);

  const handleProjectSelect = async (project: ProjectItem) => {
    onClose();
    await window.electronAPI.workspaceManager.openWorkspace(project.path);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="project-quick-open-backdrop fixed inset-0 bg-black/50 z-[99998] nim-animate-fade-in"
        onClick={onClose}
      />
      <div className="project-quick-open-modal fixed top-[20%] left-1/2 -translate-x-1/2 w-[90%] max-w-[600px] max-h-[60vh] flex flex-col overflow-hidden rounded-lg z-[99999] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        <div className="project-quick-open-header p-3 border-b border-[var(--nim-border)]">
          <div className="text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-wide mb-2">
            Projects
          </div>
          <input
            ref={searchInputRef}
            type="text"
            className="project-quick-open-search w-full py-2 px-3 text-base rounded-md outline-none box-border bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] focus:border-[#007aff] focus:shadow-[0_0_0_3px_rgba(0,122,255,0.1)]"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
        </div>

        <div className="project-quick-open-results flex-1 overflow-y-auto min-h-[200px]">
          {displayProjects.length === 0 && (
            <div className="project-quick-open-empty p-10 text-center text-[var(--nim-text-faint)]">
              {searchQuery ? 'No projects found' : 'No recent projects'}
            </div>
          )}
          {displayProjects.length > 0 && (
            <ul
              className={`project-quick-open-list list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
              ref={resultsListRef}
            >
              {displayProjects.map((project, index) => (
                <li
                  key={project.path}
                  className={`project-quick-open-item flex items-center gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] border-transparent transition-all duration-100 hover:bg-[var(--nim-bg-hover)] ${
                    index === selectedIndex
                      ? 'selected bg-[rgba(0,122,255,0.1)] border-l-[#007aff]'
                      : ''
                  }`}
                  onClick={() => handleProjectSelect(project)}
                  onMouseEnter={() => {
                    if (mouseHasMoved) {
                      setSelectedIndex(index);
                    }
                  }}
                >
                  <div className="shrink-0 flex items-center justify-center w-5 h-5 text-[var(--nim-text-muted)]">
                    <MaterialSymbol
                      icon="folder"
                      size={16}
                      fill={project.isOpen}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                      {project.name}
                      {project.isCurrent && (
                        <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[var(--nim-primary)] text-white">
                          Current
                        </span>
                      )}
                      {project.isOpen && !project.isCurrent && (
                        <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[var(--nim-success)] text-white">
                          Open
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--nim-text-faint)] mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap direction-rtl text-left">
                      {project.path}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="project-quick-open-footer flex justify-between py-2 px-4 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <div className="flex gap-4">
            <span className="text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">
                Up/Down
              </kbd>{' '}
              Navigate
            </span>
            <span className="text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">
                Enter
              </kbd>{' '}
              Open
            </span>
            <span className="text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">
                Esc
              </kbd>{' '}
              Close
            </span>
          </div>
        </div>
      </div>
    </>
  );
};
