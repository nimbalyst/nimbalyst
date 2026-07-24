/**
 * Diff Telemetry System
 *
 * Provides structured logging and metrics collection for diff operations.
 * Helps identify failure modes and performance issues in the DiffPlugin.
 */

export type DiffOperation =
  | 'text_replacement'
  | 'markdown_diff'
  | 'tree_matching'
  | 'node_application'
  | 'handler_execution';

export type DiffEventType =
  | 'start'
  | 'success'
  | 'failure'
  | 'warning'
  | 'performance';

export interface DiffTelemetryEvent {
  timestamp: number;
  operation: DiffOperation;
  eventType: DiffEventType;
  message: string;
  context?: Record<string, any>;
  duration?: number;
  error?: Error;
}

export interface DiffMetrics {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  operationDurations: Map<DiffOperation, number[]>;
  failureModes: Map<string, number>;
  warnings: string[];
}

class DiffTelemetrySystem {
  private events: DiffTelemetryEvent[] = [];
  private metrics: DiffMetrics = {
    totalOperations: 0,
    successfulOperations: 0,
    failedOperations: 0,
    operationDurations: new Map(),
    failureModes: new Map(),
    warnings: []
  };
  private operationStacks: Map<string, number> = new Map();
  private enabled: boolean = false;

  /**
   * Enable telemetry collection
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable telemetry collection
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start tracking an operation
   */
  startOperation(operation: DiffOperation, context?: Record<string, any>): string {
    if (!this.enabled) return '';

    const operationId = `${operation}-${Date.now()}-${Math.random()}`;
    this.operationStacks.set(operationId, Date.now());

    this.logEvent({
      timestamp: Date.now(),
      operation,
      eventType: 'start',
      message: `Starting ${operation}`,
      context
    });

    return operationId;
  }

  /**
   * End tracking an operation successfully
   */
  endOperation(
    operationId: string,
    operation: DiffOperation,
    context?: Record<string, any>
  ): void {
    if (!this.enabled) return;

    const startTime = this.operationStacks.get(operationId);
    if (!startTime) return;

    const duration = Date.now() - startTime;
    this.operationStacks.delete(operationId);

    // Update metrics
    this.metrics.totalOperations++;
    this.metrics.successfulOperations++;

    if (!this.metrics.operationDurations.has(operation)) {
      this.metrics.operationDurations.set(operation, []);
    }
    this.metrics.operationDurations.get(operation)!.push(duration);

    this.logEvent({
      timestamp: Date.now(),
      operation,
      eventType: 'success',
      message: `Completed ${operation}`,
      duration,
      context
    });
  }

  /**
   * Record an operation failure
   */
  failOperation(
    operationId: string,
    operation: DiffOperation,
    error: Error,
    context?: Record<string, any>
  ): void {
    if (!this.enabled) return;

    const startTime = this.operationStacks.get(operationId);
    let duration: number | undefined;

    if (startTime) {
      duration = Date.now() - startTime;
      this.operationStacks.delete(operationId);
    }

    // Update metrics
    this.metrics.totalOperations++;
    this.metrics.failedOperations++;

    const failureMode = error.name || 'UnknownError';
    this.metrics.failureModes.set(
      failureMode,
      (this.metrics.failureModes.get(failureMode) || 0) + 1
    );

    this.logEvent({
      timestamp: Date.now(),
      operation,
      eventType: 'failure',
      message: `Failed ${operation}: ${error.message}`,
      duration,
      error,
      context
    });
  }

  /**
   * Log a warning
   */
  logWarning(
    operation: DiffOperation,
    message: string,
    context?: Record<string, any>
  ): void {
    if (!this.enabled) return;

    this.metrics.warnings.push(message);

    this.logEvent({
      timestamp: Date.now(),
      operation,
      eventType: 'warning',
      message,
      context
    });
  }

  /**
   * Log a performance metric
   */
  logPerformance(
    operation: DiffOperation,
    message: string,
    duration: number,
    context?: Record<string, any>
  ): void {
    if (!this.enabled) return;

    this.logEvent({
      timestamp: Date.now(),
      operation,
      eventType: 'performance',
      message,
      duration,
      context
    });
  }

  /**
   * Log an event
   */
  private logEvent(event: DiffTelemetryEvent): void {
    this.events.push(event);

    // Console logging for development
    const prefix = this.getEventPrefix(event.eventType);
    const contextStr = event.context ? ` | ${JSON.stringify(event.context)}` : '';
    const durationStr = event.duration ? ` (${event.duration}ms)` : '';

    console.log(`${prefix} [${event.operation}] ${event.message}${durationStr}${contextStr}`);

    if (event.error) {
      console.error('Error details:', event.error);
    }
  }

  /**
   * Get emoji prefix for event type
   */
  private getEventPrefix(eventType: DiffEventType): string {
    switch (eventType) {
      case 'start':
        return '▶️';
      case 'success':
        return '✅';
      case 'failure':
        return '❌';
      case 'warning':
        return '⚠️';
      case 'performance':
        return '⏱️';
      default:
        return '📊';
    }
  }

  /**
   * Get all collected events
   */
  getEvents(): DiffTelemetryEvent[] {
    return [...this.events];
  }

  /**
   * Get metrics summary
   */
  getMetrics(): DiffMetrics {
    return {
      ...this.metrics,
      operationDurations: new Map(this.metrics.operationDurations),
      failureModes: new Map(this.metrics.failureModes),
      warnings: [...this.metrics.warnings]
    };
  }

  /**
   * Get a formatted report
   */
  getReport(): string {
    const lines: string[] = [];

    lines.push('=== Diff Telemetry Report ===');
    lines.push('');

    lines.push('Overall Metrics:');
    lines.push(`  Total Operations: ${this.metrics.totalOperations}`);
    lines.push(`  Successful: ${this.metrics.successfulOperations}`);
    lines.push(`  Failed: ${this.metrics.failedOperations}`);
    lines.push(`  Success Rate: ${
      this.metrics.totalOperations > 0
        ? ((this.metrics.successfulOperations / this.metrics.totalOperations) * 100).toFixed(2)
        : 0
    }%`);
    lines.push('');

    if (this.metrics.operationDurations.size > 0) {
      lines.push('Performance by Operation:');
      for (const [operation, durations] of this.metrics.operationDurations) {
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const max = Math.max(...durations);
        const min = Math.min(...durations);
        lines.push(`  ${operation}:`);
        lines.push(`    Count: ${durations.length}`);
        lines.push(`    Avg: ${avg.toFixed(2)}ms`);
        lines.push(`    Min: ${min}ms`);
        lines.push(`    Max: ${max}ms`);
      }
      lines.push('');
    }

    if (this.metrics.failureModes.size > 0) {
      lines.push('Failure Modes:');
      for (const [mode, count] of this.metrics.failureModes) {
        lines.push(`  ${mode}: ${count} occurrences`);
      }
      lines.push('');
    }

    if (this.metrics.warnings.length > 0) {
      lines.push(`Warnings (showing last 10 of ${this.metrics.warnings.length}):`);
      const recentWarnings = this.metrics.warnings.slice(-10);
      for (const warning of recentWarnings) {
        lines.push(`  - ${warning}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Clear all telemetry data
   */
  clear(): void {
    this.events = [];
    this.metrics = {
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      operationDurations: new Map(),
      failureModes: new Map(),
      warnings: []
    };
    this.operationStacks.clear();
  }

  /**
   * Export telemetry data for external analysis
   */
  export(): {
    events: DiffTelemetryEvent[];
    metrics: {
      totalOperations: number;
      successfulOperations: number;
      failedOperations: number;
      operationDurations: Record<string, number[]>;
      failureModes: Record<string, number>;
      warnings: string[];
    };
  } {
    return {
      events: this.getEvents(),
      metrics: {
        totalOperations: this.metrics.totalOperations,
        successfulOperations: this.metrics.successfulOperations,
        failedOperations: this.metrics.failedOperations,
        operationDurations: Object.fromEntries(this.metrics.operationDurations),
        failureModes: Object.fromEntries(this.metrics.failureModes),
        warnings: [...this.metrics.warnings]
      }
    };
  }
}

// Global telemetry instance
export const diffTelemetry = new DiffTelemetrySystem();

// Enable telemetry in development or when DIFF_TELEMETRY is set
if (
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'development' || process.env.DIFF_TELEMETRY === 'true')
) {
  diffTelemetry.enable();
}

// Expose on window for debugging
if (typeof window !== 'undefined') {
  (window as any).__diffTelemetry = diffTelemetry;
}
