import log from 'electron-log/main';
import Store from 'electron-store';
import { app, ipcMain } from 'electron';
import { formatLogArgs } from './formatLogArgs';

// Initialize electron-log for IPC communication with renderer.
// electron-log registers an IPC handler for '__ELECTRON_LOG__' when initialize() is called.
// We must ensure this only happens once, even if the module is re-evaluated during bundling.
// Check if the handler already exists by trying to list handlers (electron doesn't expose this,
// so we use a global flag AND catch registration errors)
const INIT_FLAG = '__electron_log_initialized__';
const ELECTRON_LOG_CHANNEL = '__ELECTRON_LOG__';

if (!(global as any)[INIT_FLAG]) {
  (global as any)[INIT_FLAG] = true;
  try {
    // Only initialize if the handler doesn't already exist
    // We can't directly check if a handler exists, so we rely on the error
    log.initialize();
  } catch (error: any) {
    // Suppress duplicate handler registration errors
    // This happens when modules are bundled into separate chunks and both try to initialize
    if (error?.message?.includes('Attempted to register a second handler')) {
      console.warn('[logger] electron-log IPC handler already registered, skipping initialization');
      // Don't throw - this is expected when runtime and electron packages are in separate chunks
    } else {
      throw error;
    }
  }
}

// Define component scopes for logging
export enum LogComponent {
  // File operations
  FILE_WATCHER = 'FILE_WATCHER',
  WORKSPACE_WATCHER = 'WORKSPACE_WATCHER',
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

  // Agent security (dev mode only - for reviewing permission checks)
  AGENT_SECURITY = 'AGENT_SECURITY',
  
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
  ANALYTICS = 'ANALYTICS',
  
  // General
  MAIN = 'MAIN',
  RENDERER = 'RENDERER',
  DEBUG = 'DEBUG',
  GENERAL = 'GENERAL'
}

// Log levels
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  SILLY = 'silly'
}

// Configuration interface
interface LoggerConfig {
  globalLevel: LogLevel;
  fileLogging: boolean;
  consoleLogging: boolean;
  components: {
    [key in LogComponent]?: {
      enabled: boolean;
      level: LogLevel;
    };
  };
}

// Default configuration
const defaultConfig: LoggerConfig = {
  globalLevel: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
  fileLogging: true,
  consoleLogging: true,
  components: {
    // File operations - verbose in dev, less in prod
    [LogComponent.FILE_WATCHER]: {
      enabled: true,
      level: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.WARN
    },
    [LogComponent.WORKSPACE_WATCHER]: {
      enabled: true,
      level: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.WARN
    },
    [LogComponent.FILE_OPERATIONS]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.FILE_TREE]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.FILE]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.AUTOSAVE]: {
      enabled: false,
      level: LogLevel.INFO
    },
    
    // Window management
    [LogComponent.WINDOW]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.SESSION]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.MENU]: {
      enabled: true,
      level: LogLevel.INFO
    },
    
    // AI services - more verbose for debugging
    [LogComponent.AI]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.AI_CLAUDE]: {
      enabled: true,
      level: LogLevel.DEBUG
    },
    [LogComponent.AI_CLAUDE_CODE]: {
      enabled: true,
      level: LogLevel.DEBUG
    },
    [LogComponent.AI_LMSTUDIO]: {
      enabled: true,
      level: LogLevel.DEBUG
    },
    [LogComponent.AI_OPENAI]: {
      enabled: true,
      level: LogLevel.DEBUG
    },
    [LogComponent.AI_SESSION]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.API]: {
      enabled: true,
      level: LogLevel.INFO
    },
    
    // Renderer specific - noisy ones disabled by default
    [LogComponent.STREAMING]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.UI]: {
      enabled: false,
      level: LogLevel.DEBUG
    },
    [LogComponent.EDITOR]: {
      enabled: false,
      level: LogLevel.DEBUG
    },
    [LogComponent.BRIDGE]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.PROTOCOL]: {
      enabled: true,
      level: LogLevel.INFO
    },
    
    // Other services
    [LogComponent.MCP]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.IPC]: {
      enabled: true,
      level: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.WARN
    },
    [LogComponent.THEME]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.STORE]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.SAVE]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.ANALYTICS]: {
      enabled: true,
      level: LogLevel.INFO
    },

    // Agent security (dev mode only - for reviewing all permission checks)
    [LogComponent.AGENT_SECURITY]: {
      enabled: process.env.NODE_ENV === 'development',
      level: LogLevel.DEBUG
    },

    // General
    [LogComponent.MAIN]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.RENDERER]: {
      enabled: true,
      level: LogLevel.INFO
    },
    [LogComponent.DEBUG]: {
      enabled: process.env.NODE_ENV === 'development',
      level: LogLevel.DEBUG
    },
    [LogComponent.GENERAL]: {
      enabled: true,
      level: LogLevel.INFO
    }
  }
};

// Store for logger configuration
const store = new Store<{ loggerConfig: LoggerConfig }>({
  name: 'logger-config'
});

// Load configuration from store or use defaults
let config: LoggerConfig = store.get('loggerConfig', defaultConfig);

// Configure electron-log
function configureLogger() {
  // Set log file location
  log.transports.file.resolvePathFn = () => {
    const path = app.getPath('userData');
    return `${path}/logs/main.log`;
  };
  
  // Set file size limit (10MB)
  log.transports.file.maxSize = 10 * 1024 * 1024;
  
  // Enable/disable transports based on config
  log.transports.file.level = config.fileLogging ? config.globalLevel : false;
  log.transports.console.level = config.consoleLogging ? config.globalLevel : false;
  
  // Clean, readable format
  log.transports.console.format = '[{h}:{i}:{s}] {scope}: {text}';
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] {scope}: {text}';
}

// Create a scoped logger for a component
function createComponentLogger(component: LogComponent) {
  // Use component name directly without parentheses
  const scope = log.scope(component.replace('_', '-'));
  
  // Create a wrapped logger that checks component configuration
  return {
    error: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.ERROR, componentConfig.level)) {
        scope.error(message, ...args);
      }
    },
    warn: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.WARN, componentConfig.level)) {
        scope.warn(message, ...args);
      }
    },
    info: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.INFO, componentConfig.level)) {
        scope.info(message, ...args);
      }
    },
    verbose: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.VERBOSE, componentConfig.level)) {
        scope.verbose(message, ...args);
      }
    },
    debug: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.DEBUG, componentConfig.level)) {
        scope.debug(message, ...args);
      }
    },
    silly: (message: string, ...args: any[]) => {
      const componentConfig = config.components[component];
      if (componentConfig?.enabled && isLevelEnabled(LogLevel.SILLY, componentConfig.level)) {
        scope.silly(message, ...args);
      }
    }
  };
}

// Check if a log level is enabled
function isLevelEnabled(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.VERBOSE, LogLevel.DEBUG, LogLevel.SILLY];
  const messageLevelIndex = levels.indexOf(messageLevel);
  const configuredLevelIndex = levels.indexOf(configuredLevel);
  return messageLevelIndex <= configuredLevelIndex;
}

// Initialize logger
configureLogger();

// Export component loggers
export const logger = {
  // File operations
  fileWatcher: createComponentLogger(LogComponent.FILE_WATCHER),
  workspaceWatcher: createComponentLogger(LogComponent.WORKSPACE_WATCHER),
  fileOperations: createComponentLogger(LogComponent.FILE_OPERATIONS),
  fileTree: createComponentLogger(LogComponent.FILE_TREE),
  file: createComponentLogger(LogComponent.FILE),
  autosave: createComponentLogger(LogComponent.AUTOSAVE),
  
  // Window management
  window: createComponentLogger(LogComponent.WINDOW),
  session: createComponentLogger(LogComponent.SESSION),
  menu: createComponentLogger(LogComponent.MENU),
  
  // AI services
  ai: createComponentLogger(LogComponent.AI),
  aiClaude: createComponentLogger(LogComponent.AI_CLAUDE),
  aiClaudeCode: createComponentLogger(LogComponent.AI_CLAUDE_CODE),
  aiLMStudio: createComponentLogger(LogComponent.AI_LMSTUDIO),
  aiOpenAI: createComponentLogger(LogComponent.AI_OPENAI),
  aiSession: createComponentLogger(LogComponent.AI_SESSION),
  api: createComponentLogger(LogComponent.API),
  
  // Renderer specific
  streaming: createComponentLogger(LogComponent.STREAMING),
  ui: createComponentLogger(LogComponent.UI),
  editor: createComponentLogger(LogComponent.EDITOR),
  bridge: createComponentLogger(LogComponent.BRIDGE),
  protocol: createComponentLogger(LogComponent.PROTOCOL),
  
  // Other services
  mcp: createComponentLogger(LogComponent.MCP),
  ipc: createComponentLogger(LogComponent.IPC),
  theme: createComponentLogger(LogComponent.THEME),
  store: createComponentLogger(LogComponent.STORE),
  save: createComponentLogger(LogComponent.SAVE),
  analytics: createComponentLogger(LogComponent.ANALYTICS),

  // Agent security (dev mode only - for reviewing all permission checks)
  agentSecurity: createComponentLogger(LogComponent.AGENT_SECURITY),

  // General
  main: createComponentLogger(LogComponent.MAIN),
  renderer: createComponentLogger(LogComponent.RENDERER),
  debug: createComponentLogger(LogComponent.DEBUG),
  general: createComponentLogger(LogComponent.GENERAL)
};

// Export configuration functions
export function updateLoggerConfig(newConfig: Partial<LoggerConfig>) {
  config = { ...config, ...newConfig };
  store.set('loggerConfig', config);
  configureLogger();
}

export function updateComponentConfig(component: LogComponent, enabled: boolean, level?: LogLevel) {
  if (!config.components[component]) {
    config.components[component] = { enabled, level: level || LogLevel.INFO };
  } else {
    config.components[component]!.enabled = enabled;
    if (level) {
      config.components[component]!.level = level;
    }
  }
  store.set('loggerConfig', config);
}

export function getLoggerConfig(): LoggerConfig {
  return config;
}

export function resetLoggerConfig() {
  config = defaultConfig;
  store.set('loggerConfig', config);
  configureLogger();
}

// Override console methods to use our logger
// This ensures all console output goes to both the log file AND stdout
export function overrideConsole() {
  const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };

  // Override console methods to log to both file and original console (stdout)
  console.log = (...args: any[]) => {
    logger.main.info(formatLogArgs(args));
    originalConsole.log(...args); // Also log to stdout
  };

  console.error = (...args: any[]) => {
    logger.main.error(formatLogArgs(args));
    originalConsole.error(...args); // Also log to stderr
  };

  console.warn = (...args: any[]) => {
    logger.main.warn(formatLogArgs(args));
    originalConsole.warn(...args); // Also log to stderr
  };

  console.info = (...args: any[]) => {
    logger.main.info(formatLogArgs(args));
    originalConsole.info(...args); // Also log to stdout
  };

  console.debug = (...args: any[]) => {
    logger.main.debug(formatLogArgs(args));
    originalConsole.debug(...args); // Also log to stdout
  };

  return originalConsole;
}
