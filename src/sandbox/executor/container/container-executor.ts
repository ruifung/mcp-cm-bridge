/**
 * Container-based Executor — unified wrapper with automatic fallback.
 * 
 * Tries direct socket communication (ContainerSocketExecutor) first,
 * and falls back to CLI-based execution (ContainerCliExecutor) if the socket
 * is unavailable or fails to initialize.
 */

import type { Executor, ExecuteResult } from '../helpers/types.js';
import { ContainerSocketExecutor, type ContainerSocketExecutorOptions } from './container-socket-executor.js';
import { ContainerCliExecutor, type ContainerCliExecutorOptions } from './container-cli-executor.js';
import { logDebug, logInfo, logError } from '../../../utils/logger.js';

const MAX_RETRIES = 3;
const MAX_RETRY_WINDOW_MS = 10_000;
const BASE_BACKOFF_MS = 500;

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

    this.initPromise = this._init().catch(err => {
      this.initPromise = null; // allow fresh attempt on next execute()
      throw err;
    });
    return this.initPromise;
  }

  /**
   * Tries to initialise an executor up to MAX_RETRIES times with exponential
   * backoff.  The whole retry window is capped at MAX_RETRY_WINDOW_MS.
   *
   * @param createFn  Factory: creates a fresh executor instance and returns it
   *                  together with its init() promise.
   * @param label     Human-readable label used in log messages ('socket'|'cli').
   * @returns         The successfully initialised executor.
   */
  private async initWithRetry(
    createFn: () => { executor: Executor & { dispose?(): void }; initPromise: Promise<void> },
    label: string,
  ): Promise<Executor & { dispose?(): void }> {
    const windowStart = Date.now();
    const errors: string[] = [];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const attemptStart = Date.now();
      const { executor, initPromise } = createFn();

      try {
        await initPromise;
        return executor;
      } catch (err) {
        const elapsed = Date.now() - attemptStart;
        const totalElapsed = Date.now() - windowStart;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Attempt ${attempt} (${elapsed}ms): ${message}`);

        logDebug(
          `[ContainerExecutor] ${label} attempt ${attempt}/${MAX_RETRIES} failed after ${elapsed}ms: ${message}`,
          { component: 'Executor' },
        );

        // Clean up the failed container before retrying.
        if (typeof executor.dispose === 'function') {
          try { executor.dispose(); } catch { /* best-effort */ }
        }

        if (attempt === MAX_RETRIES) break;

        // Compute exponential backoff, capped to the remaining window.
        const remaining = MAX_RETRY_WINDOW_MS - totalElapsed;
        const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), remaining);

        if (backoff <= 0) {
          logDebug(
            `[ContainerExecutor] ${label} retry window exhausted after ${totalElapsed}ms — giving up`,
            { component: 'Executor' },
          );
          break;
        }

        logDebug(
          `[ContainerExecutor] Retrying ${label} in ${backoff}ms... (total elapsed: ${totalElapsed}ms)`,
          { component: 'Executor' },
        );
        await new Promise<void>(resolve => setTimeout(resolve, backoff));
      }
    }

    const totalElapsed = Date.now() - windowStart;
    const n = errors.length;
    const detail = errors.join('\n');
    throw new Error(
      `All ${label} executor initialization attempts failed (${n} attempt${n === 1 ? '' : 's'} in ${totalElapsed}ms):\n${detail}`,
    );
  }

  private async _init(): Promise<void> {
    const mode = this.options.mode ?? 'auto';

    // 1. Try socket-based executor if not explicitly in 'cli' mode
    if (mode === 'auto' || mode === 'socket') {
      try {
        logDebug('[ContainerExecutor] Attempting socket-based initialization...', { component: 'Executor' });
        this.activeExecutor = await this.initWithRetry(() => {
          const executor = new ContainerSocketExecutor(this.options as ContainerSocketExecutorOptions);
          return { executor, initPromise: (executor as any).init() };
        }, 'socket');
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
      this.activeExecutor = await this.initWithRetry(() => {
        const executor = new ContainerCliExecutor(this.options as ContainerCliExecutorOptions);
        return { executor, initPromise: (executor as any).init() };
      }, 'cli');
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
