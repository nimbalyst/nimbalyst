/**
 * ExtensionLogService - Ring buffer for extension development logs
 *
 * Captures logs from multiple sources for extension debugging:
 * - Renderer console output (from extension code)
 * - Main process logs (from extension dev service)
 * - Build output (from npm run build)
 *
 * This enables AI agents to retrieve and analyze logs during extension development.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogSource = 'renderer' | 'main' | 'build';

export interface ExtensionLogEntry {
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  extensionId?: string;
  message: string;
  stack?: string;
  line?: number;
  sourceFile?: string;
}

export interface ExtensionLogFilter {
  extensionId?: string;
  lastSeconds?: number;
  logLevel?: LogLevel | 'all';
  source?: LogSource | 'all';
}

// Map Electron console-message level numbers to our log levels
const CONSOLE_LEVEL_MAP: Record<number, LogLevel> = {
  0: 'debug',   // verbose/log
  1: 'info',    // info
  2: 'warn',    // warning
  3: 'error',   // error
};

export class ExtensionLogService {
  private static instance: ExtensionLogService | null = null;

  private logs: ExtensionLogEntry[] = [];
  private readonly maxEntries: number = 1000;

  private constructor() {}

  public static getInstance(): ExtensionLogService {
    if (!ExtensionLogService.instance) {
      ExtensionLogService.instance = new ExtensionLogService();
    }
    return ExtensionLogService.instance;
  }

  /**
   * Add a log entry to the ring buffer
   */
  public addLog(entry: ExtensionLogEntry): void {
    this.logs.push(entry);

    // Trim if over capacity
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries);
    }
  }

  /**
   * Add a log from renderer console-message event
   * Automatically detects extension context from source URL
   */
  public addRendererLog(
    level: number,
    message: string,
    line: number,
    sourceId: string
  ): void {
    // Try to detect extension ID from multiple sources
    let extensionId: string | undefined;

    // 1. Check source path for extension directory
    // Extensions are loaded from paths like: extensions/com.example.my-extension/dist/index.js
    const extensionMatch = sourceId.match(/extensions\/([^/]+)/);
    if (extensionMatch) {
      extensionId = extensionMatch[1];
    }

    // 2. Check for dev extension symlinks or paths
    if (!extensionId) {
      const devExtMatch = sourceId.match(/[\\/]([^/\\]+)[\\/]dist[\\/]/);
      if (devExtMatch) {
        extensionId = devExtMatch[1];
      }
    }

    // 3. Check message prefix for extension ID pattern like [extension-id]
    // This works for blob URLs where we can't detect from path
    if (!extensionId) {
      const messagePrefixMatch = message.match(/^\[([a-zA-Z][a-zA-Z0-9._-]*)\]/);
      if (messagePrefixMatch) {
        const potentialId = messagePrefixMatch[1];
        // Exclude common non-extension prefixes
        const excludedPrefixes = [
          'PostHog', 'vite', 'Monaco', 'App', 'RENDERER', 'MAIN', 'PERF',
          'ExtensionSystem', 'ExtensionLoader', 'ExtensionPlatformService',
          'AgenticPanel', 'AISessionView', 'TrackerPlugin', 'CustomTrackers',
          'ERROR', 'WARN', 'INFO', 'DEBUG'
        ];
        if (!excludedPrefixes.some(p => potentialId.startsWith(p))) {
          extensionId = potentialId;
        }
      }
    }

    this.addLog({
      timestamp: Date.now(),
      level: CONSOLE_LEVEL_MAP[level] || 'info',
      source: 'renderer',
      extensionId,
      message,
      line,
      sourceFile: sourceId,
    });
  }

  /**
   * Add logs from build output (stdout/stderr)
   */
  public addBuildLog(
    extensionId: string,
    output: string,
    isError: boolean
  ): void {
    // Split output into lines and add each as a separate log entry
    const lines = output.split('\n').filter(line => line.trim());

    for (const line of lines) {
      // Try to detect log level from content
      let level: LogLevel = isError ? 'error' : 'info';
      const lowerLine = line.toLowerCase();
      if (lowerLine.includes('error') || lowerLine.includes('failed')) {
        level = 'error';
      } else if (lowerLine.includes('warn')) {
        level = 'warn';
      }

      this.addLog({
        timestamp: Date.now(),
        level,
        source: 'build',
        extensionId,
        message: line,
      });
    }
  }

  /**
   * Add a main process log related to extensions
   */
  public addMainLog(
    level: LogLevel,
    message: string,
    extensionId?: string
  ): void {
    this.addLog({
      timestamp: Date.now(),
      level,
      source: 'main',
      extensionId,
      message,
    });
  }

  /**
   * Get logs matching the given filter criteria
   */
  public getLogs(filter: ExtensionLogFilter = {}): ExtensionLogEntry[] {
    const {
      extensionId,
      lastSeconds = 60,
      logLevel = 'all',
      source = 'all',
    } = filter;

    const cutoffTime = Date.now() - (lastSeconds * 1000);

    // Define level priority for filtering
    const levelPriority: Record<LogLevel, number> = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };

    return this.logs.filter(entry => {
      // Time filter
      if (entry.timestamp < cutoffTime) {
        return false;
      }

      // Extension ID filter
      if (extensionId && entry.extensionId !== extensionId) {
        return false;
      }

      // Source filter
      if (source !== 'all' && entry.source !== source) {
        return false;
      }

      // Log level filter (show this level and above)
      if (logLevel !== 'all') {
        const entryPriority = levelPriority[entry.level];
        const filterPriority = levelPriority[logLevel];
        if (entryPriority > filterPriority) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Format logs for MCP tool response
   */
  public formatLogsForResponse(logs: ExtensionLogEntry[]): string {
    if (logs.length === 0) {
      return 'No logs found matching the filter criteria.';
    }

    const lines = logs.map(entry => {
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      const level = entry.level.toUpperCase().padEnd(5);
      const source = `[${entry.source}]`.padEnd(10);
      const extId = entry.extensionId ? `(${entry.extensionId}) ` : '';
      const location = entry.sourceFile && entry.line
        ? ` @ ${entry.sourceFile}:${entry.line}`
        : '';

      return `${time} ${level} ${source} ${extId}${entry.message}${location}`;
    });

    return lines.join('\n');
  }

  /**
   * Get summary statistics about current logs
   */
  public getStats(): {
    totalEntries: number;
    byLevel: Record<LogLevel, number>;
    bySource: Record<LogSource, number>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } {
    const byLevel: Record<LogLevel, number> = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
    };

    const bySource: Record<LogSource, number> = {
      renderer: 0,
      main: 0,
      build: 0,
    };

    for (const entry of this.logs) {
      byLevel[entry.level]++;
      bySource[entry.source]++;
    }

    return {
      totalEntries: this.logs.length,
      byLevel,
      bySource,
      oldestTimestamp: this.logs.length > 0 ? this.logs[0].timestamp : null,
      newestTimestamp: this.logs.length > 0 ? this.logs[this.logs.length - 1].timestamp : null,
    };
  }

  /**
   * Clear all logs
   */
  public clear(): void {
    this.logs = [];
  }

  /**
   * Clear logs for a specific extension
   */
  public clearForExtension(extensionId: string): void {
    this.logs = this.logs.filter(entry => entry.extensionId !== extensionId);
  }
}
