/**
 * Simple logger for the @nimbalyst/runtime editor
 * Syncs with the main logger if available
 */

export type LogCategory = 
  | 'streaming'
  | 'bridge'
  | 'editor'
  | 'general';

class SimpleLogger {
  private enabled: Record<LogCategory, boolean> = {
    streaming: true,
    bridge: true,
    editor: false,  // Disabled by default (noisy)
    general: true
  };

  constructor() {
    // Try to sync with main logger if available
    if (typeof window !== 'undefined' && (window as any).logger) {
      const mainLogger = (window as any).logger;
      const status = mainLogger.getStatus();
      
      // Sync relevant categories
      this.enabled.streaming = status.streaming ?? true;
      this.enabled.bridge = status.bridge ?? true;
      this.enabled.editor = status.editor ?? false;
      this.enabled.general = status.general ?? true;
    }
  }

  log(category: LogCategory, message: string, ...args: any[]) {
    if (!this.enabled[category]) return;
    
    const prefix = {
      streaming: '🔄',
      bridge: '🌉',
      editor: '📝',
      general: '📌'
    }[category] || '';
    
    console.log(`${prefix} [${category.toUpperCase()}] ${message}`, ...args);
  }
}

export const logger = new SimpleLogger();