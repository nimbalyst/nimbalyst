import log from 'electron-log/renderer';

// Define component scopes for logging (duplicated from main for renderer)
export enum LogComponent {
  // File operations
  FILE_WATCHER = 'FILE_WATCHER',
  PROJECT_WATCHER = 'PROJECT_WATCHER',
  FILE_OPERATIONS = 'FILE_OPERATIONS',
  FILE_TREE = 'FILE_TREE',
  FILE = 'FILE',
  AUTOSAVE = 'AUTOSAVE',
  
  // Window management
  WINDOW = 'WINDOW',
  SESSION = 'SESSION',
  MENU = 'MENU',
  
  // AI services
  AI = 'AI',
  AI_CLAUDE = 'AI_CLAUDE',
  AI_CLAUDE_CODE = 'AI_CLAUDE_CODE',
  AI_LMSTUDIO = 'AI_LMSTUDIO',
  AI_OPENAI = 'AI_OPENAI',
  AI_SESSION = 'AI_SESSION',
  API = 'API',
  
  // Renderer specific
  STREAMING = 'STREAMING',
  UI = 'UI',
  EDITOR = 'EDITOR',
  BRIDGE = 'BRIDGE',
  PROTOCOL = 'PROTOCOL',
  
  // Other services
  MCP = 'MCP',
  IPC = 'IPC',
  THEME = 'THEME',
  STORE = 'STORE',
  SAVE = 'SAVE',
  
  // General
  MAIN = 'MAIN',
  RENDERER = 'RENDERER',
  DEBUG = 'DEBUG',
  GENERAL = 'GENERAL'
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  SILLY = 'silly'
}

// Configure electron-log for renderer
log.transports.console.level = 'info';

// Clean, readable format
log.transports.console.format = '{scope}: {text}';

// Disabled components
const disabledComponents = new Set([
  LogComponent.UI,
  LogComponent.EDITOR,
  LogComponent.AUTOSAVE
]);

// Components with reduced verbosity (only errors and warnings)
const quietComponents = new Set([
  LogComponent.PROTOCOL  // Keep PROTOCOL quiet, but not API or STREAMING
]);

// Create a scoped logger for a component
function createComponentLogger(component: LogComponent) {
  const scope = log.scope(component);
  const isDisabled = disabledComponents.has(component);
  const isQuiet = quietComponents.has(component);
  
  return {
    error: (message: string, ...args: any[]) => {
      if (!isDisabled) scope.error(message, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      if (!isDisabled) scope.warn(message, ...args);
    },
    info: (message: string, ...args: any[]) => {
      if (!isDisabled && !isQuiet) scope.info(message, ...args);
    },
    verbose: (message: string, ...args: any[]) => {
      if (!isDisabled && !isQuiet) scope.verbose(message, ...args);
    },
    debug: (message: string, ...args: any[]) => {
      if (!isDisabled && !isQuiet) scope.debug(message, ...args);
    },
    silly: (message: string, ...args: any[]) => {
      if (!isDisabled && !isQuiet) scope.silly(message, ...args);
    },
    // Convenience method for backward compatibility with old logger
    log: (message: string, ...args: any[]) => {
      if (!isDisabled && !isQuiet) scope.info(message, ...args);
    }
  };
}

// Export component loggers for renderer
export const logger = {
  // Renderer specific
  streaming: createComponentLogger(LogComponent.STREAMING),
  ui: createComponentLogger(LogComponent.UI),
  editor: createComponentLogger(LogComponent.EDITOR),
  bridge: createComponentLogger(LogComponent.BRIDGE),
  protocol: createComponentLogger(LogComponent.PROTOCOL),
  api: createComponentLogger(LogComponent.API),
  
  // File operations
  file: createComponentLogger(LogComponent.FILE),
  autosave: createComponentLogger(LogComponent.AUTOSAVE),
  
  // Session management
  session: createComponentLogger(LogComponent.SESSION),
  aiSession: createComponentLogger(LogComponent.AI_SESSION),
  
  // General
  renderer: createComponentLogger(LogComponent.RENDERER),
  general: createComponentLogger(LogComponent.GENERAL)
};

// Add compatibility method for old logger API
(logger as any).getStatus = () => {
  // Return a mock status object for compatibility
  return {
    streaming: true,
    bridge: true, 
    editor: false,
    general: true,
    api: true,
    session: true,
    ui: false,
    file: true,
    autosave: false,
    protocol: true
  };
};

// Expose to window for debugging (like the old logger)
if (typeof window !== 'undefined') {
  (window as any).logger = logger;
  // console.log('%c📊 Unified logger initialized. Use window.logger to log.', 'color: #00d2d3; font-weight: bold;');
}
