/**
 * Container-based Executor — unified wrapper with automatic fallback.
 * 
 * Tries direct socket communication (ContainerSocketExecutor) first,
 * and falls back to CLI-based execution (ContainerCliExecutor) if the socket
 * is unavailable or fails to initialize.
 */

import type { Executor, ExecuteResult } from '@cloudflare/codemode';
import { ContainerSocketExecutor, type ContainerSocketExecutorOptions } from './container-socket-executor.js';
import { ContainerCliExecutor, type ContainerCliExecutorOptions } from './container-cli-executor.js';
import { logDebug, logInfo, logError } from '../utils/logger.js';

export interface ContainerExecutorOptions extends Omit<ContainerSocketExecutorOptions, 'memoryLimit'>, Omit<ContainerCliExecutorOptions, 'memoryLimit'> {
  /** Memory limit (default 512MB, can be number of bytes or string like '512M') */
  memoryLimit?: number | string;
  /** Force specific implementation: 'socket' | 'cli' | 'auto' (default) */
  mode?: 'socket' | 'cli' | 'auto';
}

export class ContainerExecutor implements Executor {
  private activeExecutor: (Executor & { dispose?(): void }) | null = null;
  private options: ContainerExecutorOptions;
  private initPromise: Promise<void> | null = null;

  constructor(options: ContainerExecutorOptions = {}) {
    this.options = options;
    logDebug(`[ContainerExecutor] Initialized in ${options.mode ?? 'auto'} mode`, { component: 'Executor' });
  }

  private async init(): Promise<void> {
    if (this.activeExecutor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const mode = this.options.mode ?? 'auto';

    // 1. Try socket-based executor if not explicitly in 'cli' mode
    if (mode === 'auto' || mode === 'socket') {
      try {
        logDebug('[ContainerExecutor] Attempting socket-based initialization...', { component: 'Executor' });
        const socketExecutor = new ContainerSocketExecutor(this.options as ContainerSocketExecutorOptions);
        // We trigger a ping/init check here
        await (socketExecutor as any).init();
        this.activeExecutor = socketExecutor;
        logInfo('[ContainerExecutor] Using socket-based implementation', { component: 'Executor' });
        return;
      } catch (err) {
        logDebug(`[ContainerExecutor] Socket-based initialization failed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
        if (mode === 'socket') throw err;
        logInfo('[ContainerExecutor] Falling back to CLI-based implementation', { component: 'Executor' });
      }
    }

    // 2. Use CLI-based executor as fallback or if explicitly requested
    try {
      logDebug('[ContainerExecutor] Initializing CLI-based executor...', { component: 'Executor' });
      const cliExecutor = new ContainerCliExecutor(this.options as ContainerCliExecutorOptions);
      // Trigger init to check if runtime exists
      await (cliExecutor as any).init();
      this.activeExecutor = cliExecutor;
      logInfo('[ContainerExecutor] Using CLI-based implementation', { component: 'Executor' });
    } catch (err) {
      logError(`[ContainerExecutor] All container executor implementations failed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
      throw err;
    }
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    await this.init();
    if (!this.activeExecutor) {
      throw new Error('Failed to initialize any container executor implementation');
    }
    return this.activeExecutor.execute(code, fns);
  }

  dispose(): void {
    if (this.activeExecutor && typeof this.activeExecutor.dispose === 'function') {
      this.activeExecutor.dispose();
      this.activeExecutor = null;
    }
    this.initPromise = null;
  }
}

export function createContainerExecutor(options?: ContainerExecutorOptions): ContainerExecutor {
  return new ContainerExecutor(options);
}
