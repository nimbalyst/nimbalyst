/**
 * TabEditorErrorBoundary - Error boundary for individual tab editors
 *
 * Wraps each TabEditor instance to catch errors during rendering or in lifecycle methods.
 * When an error occurs, shows a recovery UI instead of crashing the entire app.
 * Other tabs remain functional.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../../utils/logger';

interface Props {
  children: ReactNode;
  filePath: string;
  fileName: string;
  onRetry?: () => void;
  onClose?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class TabEditorErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.ui.error(`[TabEditorErrorBoundary] Error in tab editor for ${this.props.filePath}:`, error);
    logger.ui.error(`[TabEditorErrorBoundary] Component stack:`, errorInfo.componentStack);

    this.setState({ errorInfo });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onRetry?.();
  };

  handleClose = (): void => {
    this.props.onClose?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className="tab-editor-error-fallback"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '24px',
            backgroundColor: 'var(--nim-bg-secondary)',
            color: 'var(--nim-text)',
          }}
        >
          <div style={{
            maxWidth: '500px',
            textAlign: 'center',
          }}>
            <h3 style={{
              margin: '0 0 16px 0',
              color: 'var(--nim-text)',
              fontSize: '18px',
            }}>
              Unable to Load Editor
            </h3>

            <p style={{
              margin: '0 0 8px 0',
              color: 'var(--nim-text-muted)',
              fontSize: '14px',
            }}>
              An error occurred while loading "{this.props.fileName}".
            </p>

            <p style={{
              margin: '0 0 24px 0',
              color: 'var(--nim-text-faint)',
              fontSize: '13px',
            }}>
              Other tabs should continue to work normally.
            </p>

            {this.state.error && (
              <pre style={{
                margin: '0 0 24px 0',
                padding: '12px',
                backgroundColor: 'var(--nim-bg-tertiary)',
                border: '1px solid var(--nim-border)',
                borderRadius: '4px',
                fontSize: '12px',
                color: 'var(--nim-text-muted)',
                textAlign: 'left',
                overflow: 'auto',
                maxHeight: '150px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {this.state.error.message}
              </pre>
            )}

            <div style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'center',
            }}>
              <button
                onClick={this.handleRetry}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--nim-primary)',
                  color: 'var(--nim-on-primary)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Try Again
              </button>

              {this.props.onClose && (
                <button
                  onClick={this.handleClose}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: 'var(--nim-bg)',
                    color: 'var(--nim-text)',
                    border: '1px solid var(--nim-border)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  Close Tab
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
