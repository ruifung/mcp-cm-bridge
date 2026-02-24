/**
 * Logger utility using Winston
 * 
 * Provides structured logging with debug mode support
 * All logs go to stderr to avoid interfering with JSON-RPC protocol on stdout
 */

import winston from 'winston';

let logger: winston.Logger;
let debugMode = false;

/**
 * Initialize the logger
 */
export function initializeLogger(debug: boolean = false): void {
  debugMode = debug;
  
  const level = debug ? 'debug' : 'info';
  
  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        // Only include timestamp in debug mode
        const timestampStr = debug ? `[${timestamp}] ` : '';
        const levelStr = `[${level.toUpperCase()}]`;
        const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
        return `${timestampStr}${levelStr} ${message} ${metaStr}`.trim();
      })
    ),
    transports: [
      // Always write to stderr to avoid interfering with stdout (used for JSON-RPC protocol)
      new winston.transports.Stream({ stream: process.stderr }),
    ],
  });
}

/**
 * Get the logger instance
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    initializeLogger();
  }
  return logger;
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return debugMode;
}

/**
 * Log an info message
 */
export function logInfo(message: string, meta?: Record<string, any>): void {
  getLogger().info(message, meta);
}

/**
 * Log a debug message
 */
export function logDebug(message: string, meta?: Record<string, any>): void {
  getLogger().debug(message, meta);
}

/**
 * Log a warning message
 */
export function logWarn(message: string, meta?: Record<string, any>): void {
  getLogger().warn(message, meta);
}

/**
 * Log an error message
 */
export function logError(message: string, error?: Error | Record<string, any>): void {
  if (error instanceof Error) {
    getLogger().error(message, { error: error.message, stack: error.stack });
  } else {
    getLogger().error(message, error);
  }
}
