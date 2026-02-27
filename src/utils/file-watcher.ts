/**
 * FileWatcher - Resilient file system watcher
 *
 * Wraps `fs.watch` with debouncing, auto-reattach on atomic writes,
 * content-change detection, and graceful error handling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logDebug, logWarn } from '../utils/logger.js';

const COMPONENT = 'FileWatcher';

export interface FileWatcherOptions {
  /** Debounce interval in milliseconds. Default: 300 */
  debounceMs?: number;
  /** Polling interval in milliseconds for reattach after file deletion. Default: 2000 */
  pollIntervalMs?: number;
}

export type FileChangeCallback = (filePath: string) => void | Promise<void>;

/**
 * Resilient file watcher that handles debouncing, atomic-write reattach,
 * content-change detection, and common error conditions.
 *
 * @example
 * const watcher = new FileWatcher('/path/to/config.json', (filePath) => {
 *   console.log('File changed:', filePath);
 * });
 * watcher.start();
 * // ...later...
 * watcher.close();
 */
export class FileWatcher {
  private readonly filePath: string;
  private readonly callback: FileChangeCallback;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;

  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _isWatching: boolean = false;

  /** mtime of the file as of the last time the callback was fired */
  private lastMtime: number = 0;

  constructor(
    filePath: string,
    callback: FileChangeCallback,
    options?: FileWatcherOptions,
  ) {
    this.filePath = path.resolve(filePath);
    this.callback = callback;
    this.debounceMs = options?.debounceMs ?? 300;
    this.pollIntervalMs = options?.pollIntervalMs ?? 2000;
  }

  /**
   * Whether the watcher is currently active (either watching via `fs.watch`
   * or polling while waiting for the file to reappear).
   */
  get isWatching(): boolean {
    return this._isWatching;
  }

  /**
   * Start watching the file. Safe to call if already watching — subsequent
   * calls are no-ops.
   */
  start(): void {
    if (this._isWatching) {
      return;
    }
    this._isWatching = true;
    this.attach();
  }

  /**
   * Stop watching and clean up all timers and native watchers.
   */
  close(): void {
    this._isWatching = false;
    this.detach();
    this.clearDebounce();
    this.stopPolling();
    logDebug('File watcher closed', { component: COMPONENT, filePath: this.filePath });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Attempt to attach `fs.watch` to the target file. If the file does not
   * exist yet, falls back to polling until it appears.
   */
  private attach(): void {
    // Capture current mtime as the baseline so we don't fire spuriously on start.
    this.lastMtime = this.readMtime();

    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, (eventType) => {
        this.onFsEvent(eventType);
      });

      this.watcher.on('error', (err: NodeJS.ErrnoException) => {
        this.onWatcherError(err);
      });

      this.stopPolling(); // no longer needed once the native watcher is up
      logDebug('Watching file', { component: COMPONENT, filePath: this.filePath });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        // File doesn't exist yet — start polling for it
        logDebug('File not found, polling for creation', {
          component: COMPONENT,
          filePath: this.filePath,
        });
        this.startPolling();
      } else {
        logWarn(`Failed to attach watcher: ${e.message}`, {
          component: COMPONENT,
          filePath: this.filePath,
          code: e.code,
        });
      }
    }
  }

  /** Tear down the native `fs.watch` instance if active. */
  private detach(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore errors during teardown
      }
      this.watcher = null;
    }
  }

  /**
   * Handle raw events from `fs.watch`. Schedules a debounced check rather
   * than immediately firing the callback.
   */
  private onFsEvent(eventType: string): void {
    logDebug(`fs.watch event: ${eventType}`, {
      component: COMPONENT,
      filePath: this.filePath,
    });
    this.scheduleDebounce();
  }

  /**
   * Handle errors emitted by the `fs.FSWatcher`. On ENOENT (file deleted),
   * detach and start polling so we reattach when the file reappears (handles
   * atomic writes: write-to-temp + rename).
   */
  private onWatcherError(err: NodeJS.ErrnoException): void {
    if (err.code === 'ENOENT') {
      logDebug('Watched file deleted — polling for reappearance', {
        component: COMPONENT,
        filePath: this.filePath,
      });
    } else {
      logWarn(`Watcher error (${err.code ?? 'unknown'}): ${err.message}`, {
        component: COMPONENT,
        filePath: this.filePath,
      });
    }

    this.detach();

    if (this._isWatching) {
      this.startPolling();
    }
  }

  /** Start the polling interval used when waiting for the file to reappear. */
  private startPolling(): void {
    if (this.pollTimer !== null) {
      return; // already polling
    }
    this.pollTimer = setInterval(() => {
      this.pollForReappearance();
    }, this.pollIntervalMs);
  }

  /** Stop the reattach-polling interval. */
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Called on each poll tick. If the file now exists, detach the polling and
   * reattach via `fs.watch`, then fire the callback because the content has
   * (re-)appeared.
   */
  private pollForReappearance(): void {
    if (!fs.existsSync(this.filePath)) {
      return; // still missing
    }

    logDebug('File reappeared — reattaching watcher', {
      component: COMPONENT,
      filePath: this.filePath,
    });
    this.stopPolling();
    this.attach();

    // Treat reappearance as a change so the caller re-reads the file.
    this.fireCallback();
  }

  /** Schedule a debounced content-change check. */
  private scheduleDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.checkAndFire();
    }, this.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * After the debounce window expires, compare the current mtime to the last
   * known mtime. Only fire the callback if the file actually changed.
   */
  private checkAndFire(): void {
    const currentMtime = this.readMtime();

    if (currentMtime === 0) {
      // File disappeared during the debounce window — the watcher error
      // handler will take care of reattaching; nothing to fire.
      return;
    }

    if (currentMtime === this.lastMtime) {
      logDebug('Debounce resolved but mtime unchanged — skipping callback', {
        component: COMPONENT,
        filePath: this.filePath,
      });
      return;
    }

    this.lastMtime = currentMtime;
    this.fireCallback();
  }

  /** Invoke the user callback, absorbing any thrown errors. */
  private fireCallback(): void {
    logDebug('File change detected — invoking callback', {
      component: COMPONENT,
      filePath: this.filePath,
    });

    try {
      const result = this.callback(this.filePath);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          logWarn(`Callback threw an async error: ${err instanceof Error ? err.message : String(err)}`, {
            component: COMPONENT,
            filePath: this.filePath,
          });
        });
      }
    } catch (err) {
      logWarn(`Callback threw a synchronous error: ${err instanceof Error ? (err as Error).message : String(err)}`, {
        component: COMPONENT,
        filePath: this.filePath,
      });
    }
  }

  /**
   * Return the file's mtime as a millisecond epoch value, or 0 if the file
   * cannot be stat'd (e.g. ENOENT, EPERM).
   */
  private readMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        logWarn(`stat failed (${e.code ?? 'unknown'}): ${e.message}`, {
          component: COMPONENT,
          filePath: this.filePath,
        });
      }
      return 0;
    }
  }
}
