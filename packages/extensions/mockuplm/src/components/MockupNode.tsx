/**
 * MockupNode - React Flow node for mockup cards on the project canvas.
 *
 * Shows a scaled-down preview of the mockup HTML file inside an iframe.
 * The preview is live: changes to the mockup file update the preview.
 */

import { memo, useRef, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { renderMockupHtml } from '../utils/mockupDomUtils';
import { injectTheme, type MockupTheme } from '../utils/themeEngine';
import type { MockupReference } from '../types/project';
import type { MockupProjectStoreApi } from '../store/projectStore';

export interface MockupNodeData extends Record<string, unknown> {
  mockup: MockupReference;
  isSelected: boolean;
  store: MockupProjectStoreApi;
  /** HTML content for this mockup (loaded by the editor) */
  htmlContent?: string;
  onOpenMockup?: (path: string) => void;
  /** Mockup theme for CSS variable injection */
  mockupTheme?: MockupTheme;
}

const PREVIEW_SCALE = 0.4;

export const MockupNode = memo(function MockupNode({ data }: NodeProps) {
  const { mockup, isSelected, htmlContent, mockupTheme } = data as unknown as MockupNodeData;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  // Render HTML content into the iframe with theme
  useEffect(() => {
    if (!iframeRef.current || !htmlContent) return;
    renderMockupHtml(iframeRef.current, htmlContent, {
      onAfterRender: (doc) => {
        injectTheme(doc, mockupTheme || 'dark');
      },
    });
  }, [htmlContent, mockupTheme]);

  const filename = mockup.path.split('/').pop() || mockup.path;

  return (
    <div
      className="mockup-node"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: mockup.size.width,
        background: 'var(--nim-bg)',
        borderRadius: 8,
        border: isSelected ? '2px solid var(--nim-primary)' : '1px solid var(--nim-border)',
        boxShadow: isSelected
          ? '0 0 0 2px color-mix(in srgb, var(--nim-primary) 30%, transparent)'
          : isHovered
          ? '0 4px 12px rgba(0, 0, 0, 0.4)'
          : '0 2px 8px rgba(0, 0, 0, 0.3)',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'box-shadow 0.15s ease',
      }}
    >
      {/* Connection handles */}
      <Handle type="target" position={Position.Left} style={{ background: 'var(--nim-primary)' }} />
      <Handle type="source" position={Position.Right} style={{ background: 'var(--nim-primary)' }} />

      {/* Label header */}
      <div
        style={{
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--nim-text)',
          background: 'var(--nim-bg-secondary)',
          borderBottom: '1px solid var(--nim-border)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={mockup.path}
      >
        {mockup.label || filename}
      </div>

      {/* Preview area */}
      <div
        style={{
          width: mockup.size.width,
          height: mockup.size.height,
          overflow: 'hidden',
          position: 'relative',
          background: 'var(--nim-bg-secondary)',
        }}
      >
        {htmlContent ? (
          <iframe
            ref={iframeRef}
            sandbox="allow-same-origin"
            style={{
              width: mockup.size.width / PREVIEW_SCALE,
              height: mockup.size.height / PREVIEW_SCALE,
              transform: `scale(${PREVIEW_SCALE})`,
              transformOrigin: 'top left',
              border: 'none',
              pointerEvents: 'none',
            }}
            title={mockup.label || filename}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--nim-text-faint)',
              fontSize: 13,
            }}
          >
            {filename}
          </div>
        )}
      </div>
    </div>
  );
});
