/**
 * Logger utility using Winston
 * 
 * Provides structured logging with debug mode support
 * All logs go to stderr to avoid interfering with JSON-RPC protocol on stdout
 */

import winston from 'winston';
import chalk from 'chalk';

let logger: winston.Logger;
let debugMode = false;
let stderrBufferingEnabled = false;
let stderrBuffer: Array<{ message: string; meta?: Record<string, any> }> = [];

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
      winston.format.printf(({ level, message, timestamp, component, ...meta }) => {
        // Color the level based on severity
        let coloredLevel: string;
        switch (level.toUpperCase()) {
          case 'ERROR':
            coloredLevel = chalk.red(`[${level.toUpperCase()}]`);
            break;
          case 'WARN':
            coloredLevel = chalk.yellow(`[${level.toUpperCase()}]`);
            break;
          case 'INFO':
            coloredLevel = chalk.green(`[${level.toUpperCase()}]`);
            break;
          case 'DEBUG':
            coloredLevel = chalk.blue(`[${level.toUpperCase()}]`);
            break;
          default:
            coloredLevel = `[${level.toUpperCase()}]`;
        }
        
        // Build the prefix with timestamp (debug only)
        const timestampStr = debug ? `[${timestamp}] ` : '';
        
        // Add component prefix if provided (colored in cyan)
        const componentStr = component ? ` ${chalk.cyan(`[${component}]`)}` : '';
        
        // Include remaining metadata if present
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        
        return `${timestampStr}${coloredLevel}${componentStr} ${message}${metaStr}`.trim();
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
 * Enable buffering of stderr output from stdio tools
 * Useful for deferring tool output until after startup is complete
 */
export function enableStderrBuffering(): void {
  stderrBufferingEnabled = true;
  stderrBuffer = [];
}

/**
 * Disable buffering and flush all buffered stderr messages
 */
export function flushStderrBuffer(): void {
  stderrBufferingEnabled = false;
  const buffered = stderrBuffer;
  stderrBuffer = [];
  
  // Log all buffered messages directly without going through logInfo to avoid recursion
  for (const { message, meta } of buffered) {
    getLogger().info(message, meta);
  }
}

/**
 * Log an info message
 */
export function logInfo(message: string, meta?: Record<string, any>): void {
  // Buffer stderr output from stdio tools during startup if buffering is enabled
  if (stderrBufferingEnabled && meta?.component && meta.component !== 'Bridge') {
    stderrBuffer.push({ message, meta });
  } else {
    getLogger().info(message, meta);
  }
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
