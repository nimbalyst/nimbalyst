import React, { useState, useEffect } from 'react';
import type { PromptMarker } from '../types';
import { formatTimeAgo, formatDuration } from '../../../utils/dateUtils';

interface TranscriptSidebarProps {
  sessionId: string;
  prompts: PromptMarker[];
  onNavigateToPrompt: (marker: PromptMarker) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const TranscriptSidebar: React.FC<TranscriptSidebarProps> = ({
  sessionId,
  prompts,
  onNavigateToPrompt,
  isCollapsed,
  onToggleCollapse
}) => {
  const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null);

  const handlePromptClick = (marker: PromptMarker) => {
    setSelectedPromptId(marker.id);
    onNavigateToPrompt(marker);
  };

  return (
    <div className="transcript-sidebar" style={{
      display: 'flex',
      flex: 1,
      height: '100%',
      overflow: 'hidden'
    }}>
      {!isCollapsed && (
        <div style={{
          width: '100%',
          backgroundColor: 'var(--nim-bg-secondary)',
          borderLeft: '1px solid var(--nim-border)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          boxSizing: 'border-box'
        }}>
          <div style={{
            padding: '0.75rem 1rem',
          }}>
            <h3 style={{
              fontWeight: 600,
              color: 'var(--nim-text)',
              fontSize: '0.875rem',
              margin: 0
            }}>
              Prompt History
            </h3>
          </div>

          <div style={{
            flex: 1,
            overflowY: 'auto',
            paddingTop: '0.5rem',
            paddingBottom: '0.5rem'
          }}>
            {prompts.length === 0 ? (
              <div style={{
                padding: '1rem',
                color: 'var(--nim-text-faint)',
                fontSize: '0.875rem'
              }}>
                No prompts yet. Start by entering a prompt.
              </div>
            ) : (
              <>
                {prompts.map((marker, index) => (
                  <button
                    key={marker.id}
                    onClick={() => handlePromptClick(marker)}
                    style={{
                      display: 'block',
                      width: '100%',
                      boxSizing: 'border-box',
                      textAlign: 'left',
                      padding: '0.875rem 1rem',
                      margin: 0,
                      borderRadius: 0,
                      transition: 'all 0.2s ease',
                      backgroundColor: selectedPromptId === marker.id
                        ? 'var(--nim-bg-hover)'
                        : 'transparent',
                      borderTop: '1px solid var(--nim-border)',
                      borderBottom: selectedPromptId === marker.id
                        ? '1px solid var(--nim-primary)'
                        : '1px solid transparent',
                      borderLeft: selectedPromptId === marker.id
                        ? '2px solid var(--nim-primary)'
                        : '2px solid transparent',
                      borderRight: 'none',
                      cursor: 'pointer',
                      color: 'inherit',
                      fontFamily: 'inherit',
                      outline: 'none'
                    }}
                    onMouseEnter={(e) => {
                      if (selectedPromptId !== marker.id) {
                        e.currentTarget.style.backgroundColor = 'var(--nim-bg-hover)';
                        e.currentTarget.style.borderColor = 'var(--nim-border)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedPromptId !== marker.id) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.borderColor = 'var(--nim-border)';
                      }
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.625rem',
                      width: '100%'
                    }}>
                      <span style={{
                        color: 'var(--nim-primary)',
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        flexShrink: 0
                      }}>
                        #{index + 1}
                      </span>
                      <div style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden'
                      }}>
                        <div style={{
                          fontSize: '0.875rem',
                          color: 'var(--nim-text)',
                          lineHeight: '1.5',
                          marginBottom: '0.5rem',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word'
                        }}>
                          {marker.promptText}
                        </div>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontSize: '0.75rem',
                          color: 'var(--nim-text-faint)'
                        }}>
                          <span>{formatTimeAgo(marker.timestamp)}</span>
                          {marker.completionTimestamp && (
                            <>
                              <span>•</span>
                              <span style={{
                                color: 'var(--nim-text-muted)'
                              }}>
                                {formatDuration(marker.timestamp, marker.completionTimestamp)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
