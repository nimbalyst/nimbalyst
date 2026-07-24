/**
 * MockupProjectCanvas - React Flow canvas for the project view.
 *
 * Displays mockup cards as nodes and navigation flows as edges
 * on an infinite pannable/zoomable canvas.
 * Supports drag-to-connect between nodes and right-click context menu with
 * inline editing. Double-click opens the mockup in the editor.
 */

import { useCallback, useMemo, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
  type EdgeTypes,
  type Connection as RFConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MockupNode, type MockupNodeData } from './MockupNode';
import { ConnectionEdge, type ConnectionEdgeData } from './ConnectionEdge';
import type { MockupProjectStoreApi } from '../store/projectStore';
import type { MockupTheme } from '../utils/themeEngine';

interface MockupProjectCanvasProps {
  store: MockupProjectStoreApi;
  /** Map of mockup path -> HTML content for live previews */
  mockupContents: Map<string, string>;
  /** Callback when user double-clicks a mockup node to open it */
  onOpenMockup?: (path: string) => void;
  /** Current mockup theme for preview iframes */
  mockupTheme: MockupTheme;
}

export interface MockupProjectCanvasRef {
  getCanvasElement: () => HTMLElement | null;
}

type ContextMenuState =
  | { x: number; y: number; nodeId: string; edgeId?: undefined }
  | { x: number; y: number; nodeId?: undefined; edgeId: string }
  | null;

/** State for inline editing within context menu */
type InlineEditState =
  | { type: 'rename'; nodeId: string; value: string }
  | { type: 'label'; edgeId: string; value: string }
  | null;

export const MockupProjectCanvas = forwardRef<MockupProjectCanvasRef, MockupProjectCanvasProps>(
  function MockupProjectCanvas({ store, mockupContents, onOpenMockup, mockupTheme }, ref) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const reactFlowInstance = useReactFlow();
    const hasFitViewRef = useRef(false);
    const nodeTypesRef = useRef<NodeTypes>({ mockup: MockupNode as any });
    const edgeTypesRef = useRef<EdgeTypes>({ connection: ConnectionEdge as any });
    const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
    const [inlineEdit, setInlineEdit] = useState<InlineEditState>(null);
    const inlineInputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      getCanvasElement: () => canvasRef.current,
    }));

    const state = store.getState();
    const { mockups, connections, selectedMockupId, selectedConnectionId } = state;

    // Convert mockups to React Flow nodes
    const storeNodes: Node<MockupNodeData>[] = useMemo(
      () =>
        mockups.map((mockup) => ({
          id: mockup.id,
          type: 'mockup',
          position: mockup.position,
          data: {
            mockup,
            isSelected: selectedMockupId === mockup.id,
            store,
            htmlContent: mockupContents.get(mockup.path),
            onOpenMockup,
            mockupTheme,
          },
        })),
      [mockups, selectedMockupId, store, mockupContents, onOpenMockup, mockupTheme]
    );

    // Convert connections to React Flow edges
    const storeEdges: Edge<ConnectionEdgeData>[] = useMemo(() => {
      return connections.map((conn) => ({
        id: conn.id,
        type: 'connection',
        source: conn.fromMockupId,
        target: conn.toMockupId,
        selected: selectedConnectionId === conn.id,
        data: { connection: conn },
      }));
    }, [connections, selectedConnectionId]);

    const [nodes, setNodes] = useNodesState(storeNodes);
    const [edges, setEdges] = useEdgesState(storeEdges);

    // Sync store -> local React Flow state
    useEffect(() => {
      setNodes(storeNodes);
    }, [storeNodes, setNodes]);

    useEffect(() => {
      setEdges(storeEdges);
    }, [storeEdges, setEdges]);

    // Fit view once when nodes first appear (data loads after mount)
    useEffect(() => {
      if (!hasFitViewRef.current && storeNodes.length > 0) {
        hasFitViewRef.current = true;
        // Use increasing delays to ensure React Flow has finished layout
        const timers = [50, 150, 400].map(delay =>
          setTimeout(() => {
            reactFlowInstance.fitView({ padding: 0.15, duration: 200 });
          }, delay)
        );
        return () => timers.forEach(clearTimeout);
      }
    }, [storeNodes, reactFlowInstance]);

    // Handle new connections (drag from source handle to target handle)
    const onConnect = useCallback(
      (connection: RFConnection) => {
        if (!connection.source || !connection.target) return;
        // Don't create duplicate connections
        const exists = store.getState().connections.some(
          (c) => c.fromMockupId === connection.source && c.toMockupId === connection.target
        );
        if (exists) return;

        store.getState().addConnection({
          fromMockupId: connection.source,
          toMockupId: connection.target,
          label: '',
          trigger: 'click',
        });
      },
      [store]
    );

    // Handle node changes (dragging, selection)
    const onNodesChange = useCallback(
      (changes: NodeChange[]) => {
        setNodes((nds) => applyNodeChanges(changes, nds) as Node<MockupNodeData>[]);

        for (const change of changes) {
          if (change.type === 'position' && change.position && !change.dragging) {
            store.getState().updateMockup(change.id, { position: change.position });
          }
          if (change.type === 'select') {
            if (change.selected) {
              store.getState().selectMockup(change.id);
            }
          }
        }
      },
      [setNodes, store]
    );

    // Handle edge changes (selection)
    const onEdgesChange = useCallback(
      (changes: EdgeChange[]) => {
        setEdges((eds) => applyEdgeChanges(changes, eds) as Edge<ConnectionEdgeData>[]);
        for (const change of changes) {
          if (change.type === 'select' && change.selected) {
            store.getState().selectConnection(change.id);
          }
        }
      },
      [setEdges, store]
    );

    // Handle viewport changes
    const onMoveEnd = useCallback(
      (_event: any, viewport: { x: number; y: number; zoom: number }) => {
        store.getState().setViewport(viewport.x, viewport.y, viewport.zoom);
      },
      [store]
    );

    // Canvas click to deselect and close context menu
    const onPaneClick = useCallback(() => {
      store.getState().selectMockup(null);
      store.getState().selectConnection(null);
      setContextMenu(null);
      setInlineEdit(null);
    }, [store]);

    // Right-click on node
    const onNodeContextMenu = useCallback(
      (event: React.MouseEvent, node: Node) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
        setInlineEdit(null);
      },
      []
    );

    // Right-click on edge
    const onEdgeContextMenu = useCallback(
      (event: React.MouseEvent, edge: Edge) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id });
        setInlineEdit(null);
      },
      []
    );

    // Double-click on node -> open in editor
    const onNodeDoubleClick = useCallback(
      (_event: React.MouseEvent, node: Node) => {
        const mockup = store.getState().mockups.find((m) => m.id === node.id);
        if (mockup && onOpenMockup) onOpenMockup(mockup.path);
      },
      [store, onOpenMockup]
    );

    // Commit inline edit
    const commitInlineEdit = useCallback(() => {
      if (!inlineEdit) return;

      if (inlineEdit.type === 'rename') {
        const trimmed = inlineEdit.value.trim();
        if (trimmed) {
          store.getState().updateMockup(inlineEdit.nodeId, { label: trimmed });
        }
      } else if (inlineEdit.type === 'label') {
        store.getState().updateConnection(inlineEdit.edgeId, { label: inlineEdit.value });
      }

      setInlineEdit(null);
      setContextMenu(null);
    }, [inlineEdit, store]);

    // Context menu actions
    const handleContextMenuAction = useCallback(
      (action: string) => {
        if (!contextMenu) return;

        if (contextMenu.nodeId) {
          const mockup = store.getState().mockups.find((m) => m.id === contextMenu.nodeId);
          switch (action) {
            case 'open':
              if (mockup && onOpenMockup) onOpenMockup(mockup.path);
              setContextMenu(null);
              break;
            case 'delete':
              store.getState().deleteMockup(contextMenu.nodeId);
              setContextMenu(null);
              break;
            case 'rename': {
              if (mockup) {
                setInlineEdit({ type: 'rename', nodeId: contextMenu.nodeId, value: mockup.label });
              }
              break;
            }
          }
        } else if (contextMenu.edgeId) {
          switch (action) {
            case 'delete':
              store.getState().deleteConnection(contextMenu.edgeId);
              setContextMenu(null);
              break;
            case 'label': {
              const conn = store.getState().connections.find((c) => c.id === contextMenu.edgeId);
              if (conn) {
                setInlineEdit({ type: 'label', edgeId: contextMenu.edgeId, value: conn.label || '' });
              }
              break;
            }
          }
        }
      },
      [contextMenu, store, onOpenMockup]
    );

    // Focus inline input when it appears
    useEffect(() => {
      if (inlineEdit) {
        // Small delay to let DOM render
        requestAnimationFrame(() => {
          inlineInputRef.current?.focus();
          inlineInputRef.current?.select();
        });
      }
    }, [inlineEdit]);

    // Close context menu on escape
    useEffect(() => {
      if (!contextMenu) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setContextMenu(null);
          setInlineEdit(null);
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [contextMenu]);

    // Close context menu on click outside
    useEffect(() => {
      if (!contextMenu) return;
      const handleClick = () => {
        setContextMenu(null);
        setInlineEdit(null);
      };
      window.addEventListener('click', handleClick);
      return () => window.removeEventListener('click', handleClick);
    }, [contextMenu]);

    // Drag-and-drop: accept .mockup.html files from file tree
    const onDragOver = useCallback((event: React.DragEvent) => {
      const filePath = event.dataTransfer.types.includes('text/plain') ? 'pending' : null;
      if (filePath) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    }, []);

    const onDrop = useCallback(
      (event: React.DragEvent) => {
        event.preventDefault();

        const filePath = event.dataTransfer.getData('text/plain');
        if (!filePath || !filePath.endsWith('.mockup.html')) return;

        // Check if already in the project
        const existingPaths = new Set(store.getState().mockups.map((m) => m.path));
        if (existingPaths.has(filePath)) return;

        // Convert screen coordinates to flow coordinates
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        const fileName = filePath.split('/').pop() || filePath;
        const label = fileName
          .replace('.mockup.html', '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c: string) => c.toUpperCase());

        store.getState().addMockup({
          path: filePath,
          label,
          position,
        });
      },
      [store, reactFlowInstance]
    );

    return (
      <div
        ref={canvasRef}
        style={{ width: '100%', height: '100%', position: 'relative' }}
        className="mockup-project-canvas"
      >
        {/* Override React Flow panel colors for dark mode */}
        <style>{`
          .mockup-project-canvas .react-flow__controls {
            background: var(--nim-bg-secondary);
            border: 1px solid var(--nim-border);
            border-radius: 6px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          }
          .mockup-project-canvas .react-flow__controls-button {
            background: var(--nim-bg-secondary);
            border-bottom: 1px solid var(--nim-border);
            fill: var(--nim-text-muted);
            color: var(--nim-text-muted);
          }
          .mockup-project-canvas .react-flow__controls-button:hover {
            background: var(--nim-bg-tertiary);
          }
          .mockup-project-canvas .react-flow__controls-button svg {
            fill: var(--nim-text-muted);
          }
          .mockup-project-canvas .react-flow__panel {
            color: var(--nim-text);
          }
        `}</style>
        <svg style={{ position: 'absolute', width: 0, height: 0 }}>
          <defs>
            <marker
              id="mockup-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--nim-text-faint)" />
            </marker>
          </defs>
        </svg>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypesRef.current}
          edgeTypes={edgeTypesRef.current}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          snapToGrid
          snapGrid={[20, 20]}
          minZoom={0.1}
          maxZoom={2}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onPaneClick={onPaneClick}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onNodeDoubleClick={onNodeDoubleClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
          proOptions={{ hideAttribution: true }}
        >
          <Controls />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--nim-border)" />
          <MiniMap
            nodeColor="var(--nim-bg-tertiary)"
            maskColor="color-mix(in srgb, var(--nim-bg) 60%, transparent)"
            style={{ background: 'var(--nim-bg)' }}
          />
        </ReactFlow>

        {/* Context Menu */}
        {contextMenu && (
          <div
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
              background: 'var(--nim-bg-secondary)',
              border: '1px solid var(--nim-border)',
              borderRadius: 6,
              padding: '4px 0',
              minWidth: 180,
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
              zIndex: 1000,
              fontSize: 13,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.nodeId && !inlineEdit && (
              <>
                <ContextMenuItem
                  label="Open in Editor"
                  shortcut="Dbl-click"
                  onClick={() => handleContextMenuAction('open')}
                />
                <ContextMenuItem
                  label="Rename..."
                  onClick={() => handleContextMenuAction('rename')}
                />
                <div style={{ height: 1, background: 'var(--nim-border)', margin: '4px 0' }} />
                <ContextMenuItem
                  label="Delete Screen"
                  onClick={() => handleContextMenuAction('delete')}
                  danger
                />
              </>
            )}
            {contextMenu.edgeId && !inlineEdit && (
              <>
                <ContextMenuItem
                  label="Edit Label..."
                  onClick={() => handleContextMenuAction('label')}
                />
                <div style={{ height: 1, background: 'var(--nim-border)', margin: '4px 0' }} />
                <ContextMenuItem
                  label="Delete Connection"
                  onClick={() => handleContextMenuAction('delete')}
                  danger
                />
              </>
            )}
            {/* Inline edit input */}
            {inlineEdit && (
              <div style={{ padding: '6px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--nim-text-muted)', marginBottom: 4 }}>
                  {inlineEdit.type === 'rename' ? 'Rename screen' : 'Connection label'}
                </div>
                <input
                  ref={inlineInputRef}
                  type="text"
                  value={inlineEdit.value}
                  onChange={(e) =>
                    setInlineEdit((prev) => (prev ? { ...prev, value: e.target.value } : null))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitInlineEdit();
                    if (e.key === 'Escape') {
                      setInlineEdit(null);
                      setContextMenu(null);
                    }
                  }}
                  onBlur={() => commitInlineEdit()}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    fontSize: 12,
                    background: 'var(--nim-bg)',
                    color: 'var(--nim-text)',
                    border: '1px solid var(--nim-primary)',
                    borderRadius: 4,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  placeholder={inlineEdit.type === 'rename' ? 'Screen name...' : 'Label...'}
                />
              </div>
            )}
          </div>
        )}

      </div>
    );
  }
);

function ContextMenuItem({
  label,
  shortcut,
  onClick,
  danger,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '6px 12px',
        cursor: 'pointer',
        color: danger ? 'var(--nim-error)' : 'var(--nim-text)',
        background: isHovered ? 'var(--nim-bg-tertiary)' : 'transparent',
        transition: 'background 0.1s ease',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <span>{label}</span>
      {shortcut && (
        <span style={{ fontSize: 11, color: 'var(--nim-text-faint)', marginLeft: 16 }}>
          {shortcut}
        </span>
      )}
    </div>
  );
}
