import React from 'react';

interface Props {
  children: React.ReactNode;
  toolName?: string;
}

interface State {
  error: Error | null;
  showDetails: boolean;
}

export class ToolWidgetErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      `[ToolWidgetErrorBoundary] Widget "${this.props.toolName ?? 'unknown'}" crashed:`,
      { error: error.message, stack: error.stack, componentStack: errorInfo.componentStack }
    );
  }

  private reset = (): void => {
    this.setState({ error: null, showDetails: false });
  };

  private toggleDetails = (): void => {
    this.setState((s) => ({ showDetails: !s.showDetails }));
  };

  private copyError = async (): Promise<void> => {
    const err = this.state.error;
    if (!err) return;
    const text = `Tool widget: ${this.props.toolName ?? 'unknown'}\n${err.name}: ${err.message}\n${err.stack ?? ''}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable; swallow
    }
  };

  render(): React.ReactNode {
    const { error, showDetails } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          border: '1px solid var(--nim-error, #ef4444)',
          background: 'var(--nim-bg-tertiary)',
          borderRadius: '6px',
          padding: '8px 10px',
          color: 'var(--nim-text)',
          fontSize: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 600, color: 'var(--nim-error, #ef4444)' }}>
            Widget failed to render
          </span>
          <span style={{ color: 'var(--nim-text-muted)', fontFamily: 'monospace', fontSize: '11px' }}>
            {this.props.toolName ?? 'unknown tool'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={this.toggleDetails}
            style={{
              background: 'transparent',
              border: '1px solid var(--nim-border)',
              color: 'var(--nim-text-muted)',
              borderRadius: '4px',
              fontSize: '11px',
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          <button
            type="button"
            onClick={this.copyError}
            style={{
              background: 'transparent',
              border: '1px solid var(--nim-border)',
              color: 'var(--nim-text-muted)',
              borderRadius: '4px',
              fontSize: '11px',
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={this.reset}
            style={{
              background: 'transparent',
              border: '1px solid var(--nim-border)',
              color: 'var(--nim-text-muted)',
              borderRadius: '4px',
              fontSize: '11px',
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
        <div style={{ marginTop: '4px', color: 'var(--nim-text-muted)' }}>
          {error.message || 'Unknown error'}
        </div>
        {showDetails && error.stack && (
          <pre
            style={{
              marginTop: '6px',
              maxHeight: '200px',
              overflow: 'auto',
              fontSize: '10px',
              fontFamily: 'monospace',
              color: 'var(--nim-text-faint)',
              background: 'var(--nim-bg-secondary)',
              padding: '6px 8px',
              borderRadius: '4px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.stack}
          </pre>
        )}
      </div>
    );
  }
}
