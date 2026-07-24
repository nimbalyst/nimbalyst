import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, component, ...meta }) => {
  const prefix = component ? `[${component}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level} ${prefix} ${message}${metaStr}`;
});

const baseLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), logFormat),
    }),
  ],
});

/**
 * Create a child logger with a component name prefix.
 */
export function createLogger(component: string): winston.Logger {
  return baseLogger.child({ component });
}
