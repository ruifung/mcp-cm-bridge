/**
 * Unit tests for FileWatcher
 *
 * Covers:
 *  1. Basic lifecycle (start/close/isWatching)
 *  2. Idempotency of start() and close()
 *  3. Debounce — multiple rapid events collapse to one callback
 *  4. Mtime-based change detection — callback only fires when mtime changes
 *  5. Reattach on delete (ENOENT error from watcher)
 *  6. Non-ENOENT error handling
 *  7. readMtime error handling (ENOENT vs other errors)
 *  8. Callback error handling (sync throw + async rejection)
 *  9. File missing on start()
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

vi.mock('node:fs', () => ({
  watch: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import * as fs from 'node:fs';
import { logDebug, logWarn } from '../utils/logger.js';
import { FileWatcher, type FileChangeCallback } from './file-watcher.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** A minimal mock of fs.FSWatcher */
interface MockFSWatcher {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // Internal storage for the captured change listener
  _changeListener?: (eventType: string, filename?: string | null) => void;
}

function makeMockWatcher(): MockFSWatcher {
  return { on: vi.fn(), close: vi.fn() };
}

/**
 * Configure the fs.watch mock to capture both the change listener and the
 * mock watcher. Returns the mock watcher so tests can trigger error events.
 *
 * fs.watch is called as: fs.watch(path, {persistent: false}, listener)
 * We capture the listener via mock.calls[callIdx][2].
 */
function setupWatchMock(mockWatcher: MockFSWatcher): void {
  vi.mocked(fs.watch).mockImplementation(
    (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
      // The source always passes options + listener as 3rd arg
      const listener = typeof _optionsOrListener === 'function'
        ? _optionsOrListener
        : listenerArg;
      mockWatcher._changeListener = listener;
      return mockWatcher as unknown as fs.FSWatcher;
    },
  );
}

/**
 * Retrieve the change listener captured in the mock watcher.
 */
function getChangeListener(mockWatcher: MockFSWatcher): (event: string) => void {
  if (!mockWatcher._changeListener) {
    throw new Error('No change listener captured on mock watcher. Was start() called?');
  }
  return (event: string) => mockWatcher._changeListener!(event);
}

/**
 * Retrieve the 'error' event listener registered via watcher.on('error', handler).
 */
function getErrorListener(mockWatcher: MockFSWatcher): (err: NodeJS.ErrnoException) => void {
  const errorCall = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'error');
  if (!errorCall) throw new Error('No error listener registered on mock watcher');
  return errorCall[1] as (err: NodeJS.ErrnoException) => void;
}

/** Create an ErrnoException with a given code. */
function makeErrnoError(code: string, message = `mock error [${code}]`): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Stable test file path — use a fixed relative path and resolve it. */
const TEST_FILE_REL = 'test-watch-config.json';
const TEST_FILE = path.resolve(TEST_FILE_REL);

/** Default mtime returned by statSync when the file "exists". */
const BASE_MTIME = 1_700_000_000_000;

/** A typed callback mock compatible with FileChangeCallback. */
function makeCallback(): ReturnType<typeof vi.fn> & FileChangeCallback {
  return vi.fn() as ReturnType<typeof vi.fn> & FileChangeCallback;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  let mockWatcher: MockFSWatcher;
  let callback: FileChangeCallback & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatcher = makeMockWatcher();
    callback = makeCallback();

    // Default: fs.watch succeeds and returns the mock watcher (captures listener)
    setupWatchMock(mockWatcher);
    // Default: file exists with a stable mtime
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: BASE_MTIME } as fs.Stats);
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── 1. Basic lifecycle ──────────────────────────────────────────────────────

  describe('basic lifecycle', () => {
    it('should report isWatching=false before start()', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      expect(watcher.isWatching).toBe(false);
    });

    it('should attach fs.watch and set isWatching=true after start()', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      expect(fs.watch).toHaveBeenCalledTimes(1);
      expect(fs.watch).toHaveBeenCalledWith(
        TEST_FILE,
        { persistent: false },
        expect.any(Function),
      );
      expect(watcher.isWatching).toBe(true);
      watcher.close();
    });

    it('should call fs.watch with { persistent: false } option', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const args = vi.mocked(fs.watch).mock.calls[0];
      expect(args[1]).toEqual({ persistent: false });
      watcher.close();
    });

    it('should set isWatching=false and close native watcher after close()', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.close();
      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      expect(watcher.isWatching).toBe(false);
    });

    it('should log debug message when close() is called', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.close();
      expect(logDebug).toHaveBeenCalledWith(
        'File watcher closed',
        expect.objectContaining({ filePath: TEST_FILE }),
      );
    });

    it('should register an error listener on the native watcher after start()', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
      watcher.close();
    });
  });

  // ── 2. Idempotency ──────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('should not create duplicate watchers when start() is called twice', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.start(); // second call is a no-op
      expect(fs.watch).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should still report isWatching=true after second start() call', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.start();
      expect(watcher.isWatching).toBe(true);
      watcher.close();
    });

    it('should not throw when close() is called twice', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.close();
      expect(() => watcher.close()).not.toThrow();
    });

    it('should not close the native watcher a second time on double close()', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      watcher.close();
      // watcher.close() already closed the inner watcher; it's now null
      const closedCount = mockWatcher.close.mock.calls.length;
      watcher.close(); // second close — inner watcher is null
      expect(mockWatcher.close).toHaveBeenCalledTimes(closedCount);
    });

    it('should keep isWatching=false after calling close() without ever starting', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.close(); // never started
      expect(watcher.isWatching).toBe(false);
    });
  });

  // ── 3. Debounce ─────────────────────────────────────────────────────────────

  describe('debounce', () => {
    it('should not fire callback immediately when an fs event is received', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)   // baseline on start
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);  // changed on check

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { debounceMs: 300 });
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      expect(callback).not.toHaveBeenCalled();
      watcher.close();
    });

    it('should fire callback once after debounceMs elapses following a single event', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { debounceMs: 300 });
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);
      expect(callback).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should collapse multiple rapid events into a single callback invocation', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { debounceMs: 300 });
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);

      // Fire 5 rapid events — each resets the debounce timer
      changeListener('change');
      vi.advanceTimersByTime(100);
      changeListener('change');
      vi.advanceTimersByTime(100);
      changeListener('change');
      vi.advanceTimersByTime(100);
      changeListener('rename');
      vi.advanceTimersByTime(100);
      changeListener('change');

      // Before the final debounce expires, callback should not have fired
      expect(callback).not.toHaveBeenCalled();

      // Advance past the final debounce window
      vi.advanceTimersByTime(300);
      expect(callback).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should respect a custom debounceMs option', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { debounceMs: 150 });
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(149);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should cancel a pending debounce when close() is called', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { debounceMs: 300 });
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      // Close before debounce fires
      watcher.close();

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── 4. Mtime-based change detection ─────────────────────────────────────────

  describe('mtime-based change detection', () => {
    it('should fire callback when mtime has changed since the baseline', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)       // baseline
        .mockReturnValue({ mtimeMs: BASE_MTIME + 500 } as fs.Stats);    // changed

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);
      expect(callback).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should invoke callback with the resolved file path', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');
      vi.advanceTimersByTime(300);

      expect(callback).toHaveBeenCalledWith(TEST_FILE);
      watcher.close();
    });

    it('should NOT fire callback when mtime is unchanged after debounce', () => {
      // Same mtime for baseline and debounce check
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: BASE_MTIME } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);
      expect(callback).not.toHaveBeenCalled();
      watcher.close();
    });

    it('should NOT fire callback when mtime returns 0 (file disappeared during debounce)', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)  // baseline
        .mockImplementation(() => {                                  // after debounce: file gone
          throw makeErrnoError('ENOENT');
        });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);
      expect(callback).not.toHaveBeenCalled();
      watcher.close();
    });

    it('should update lastMtime after a successful callback fire', () => {
      const mtime1 = BASE_MTIME;
      const mtime2 = BASE_MTIME + 1000;

      // Sequence:
      //  call 0 (baseline on start):   mtime1
      //  call 1 (after first event):   mtime2  → callback fires, lastMtime = mtime2
      //  call 2 (after second event):  mtime2  → same as lastMtime → no callback
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: mtime1 } as fs.Stats)
        .mockReturnValueOnce({ mtimeMs: mtime2 } as fs.Stats)
        .mockReturnValue({ mtimeMs: mtime2 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);

      // First event → callback fires (mtime changed)
      changeListener('change');
      vi.advanceTimersByTime(300);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second event → callback does NOT fire (mtime same as updated lastMtime)
      changeListener('change');
      vi.advanceTimersByTime(300);
      expect(callback).toHaveBeenCalledTimes(1);

      watcher.close();
    });
  });

  // ── 5. Reattach on delete (ENOENT) ──────────────────────────────────────────

  describe('reattach on delete (ENOENT watcher error)', () => {
    it('should detach native watcher when ENOENT error is emitted', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      errorListener(makeErrnoError('ENOENT'));

      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should start polling after ENOENT error while watcher is active', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      errorListener(makeErrnoError('ENOENT'));

      // Advance one poll interval — existsSync returns false, no reattach
      vi.advanceTimersByTime(2000);
      // fs.watch should still only have been called once (the initial attach)
      expect(fs.watch).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should keep isWatching=true while polling after ENOENT', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      errorListener(makeErrnoError('ENOENT'));

      expect(watcher.isWatching).toBe(true);
      watcher.close();
    });

    it('should reattach fs.watch when polling detects the file has reappeared', () => {
      const mockWatcher2 = makeMockWatcher();
      let callCount = 0;
      vi.mocked(fs.watch).mockImplementation(
        (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
          const listener = typeof _optionsOrListener === 'function'
            ? _optionsOrListener
            : listenerArg;
          callCount++;
          if (callCount === 1) {
            mockWatcher._changeListener = listener;
            return mockWatcher as unknown as fs.FSWatcher;
          } else {
            mockWatcher2._changeListener = listener;
            return mockWatcher2 as unknown as fs.FSWatcher;
          }
        },
      );

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);
      errorListener(makeErrnoError('ENOENT'));

      // File still missing on first poll
      vi.advanceTimersByTime(2000);
      expect(fs.watch).toHaveBeenCalledTimes(1);

      // File reappears
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.advanceTimersByTime(2000);

      // fs.watch should have been called a second time for reattach
      expect(fs.watch).toHaveBeenCalledTimes(2);
      watcher.close();
    });

    it('should fire callback immediately when file reappears during polling', () => {
      const mockWatcher2 = makeMockWatcher();
      let callCount = 0;
      vi.mocked(fs.watch).mockImplementation(
        (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
          const listener = typeof _optionsOrListener === 'function'
            ? _optionsOrListener
            : listenerArg;
          callCount++;
          if (callCount === 1) {
            mockWatcher._changeListener = listener;
            return mockWatcher as unknown as fs.FSWatcher;
          } else {
            mockWatcher2._changeListener = listener;
            return mockWatcher2 as unknown as fs.FSWatcher;
          }
        },
      );

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);
      errorListener(makeErrnoError('ENOENT'));

      // File reappears on the poll tick
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.advanceTimersByTime(2000);

      expect(callback).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should stop polling once the file has reappeared and watcher is reattached', () => {
      const mockWatcher2 = makeMockWatcher();
      let callCount = 0;
      vi.mocked(fs.watch).mockImplementation(
        (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
          const listener = typeof _optionsOrListener === 'function'
            ? _optionsOrListener
            : listenerArg;
          callCount++;
          if (callCount === 1) {
            mockWatcher._changeListener = listener;
            return mockWatcher as unknown as fs.FSWatcher;
          } else {
            mockWatcher2._changeListener = listener;
            return mockWatcher2 as unknown as fs.FSWatcher;
          }
        },
      );

      vi.mocked(fs.existsSync).mockReturnValue(true); // file reappears on first poll

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);
      errorListener(makeErrnoError('ENOENT'));

      // First poll — file is back, reattach happens
      vi.advanceTimersByTime(2000);
      expect(callback).toHaveBeenCalledTimes(1);

      const watchCallsAfterReappearance = vi.mocked(fs.watch).mock.calls.length;
      // Advance well beyond multiple poll intervals — polling should have stopped
      vi.advanceTimersByTime(10000);
      expect(fs.watch).toHaveBeenCalledTimes(watchCallsAfterReappearance);

      watcher.close();
    });

    it('should log debug when ENOENT error is received from watcher', () => {
      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      errorListener(makeErrnoError('ENOENT'));

      expect(logDebug).toHaveBeenCalledWith(
        expect.stringContaining('deleted'),
        expect.objectContaining({ filePath: TEST_FILE }),
      );
      watcher.close();
    });

    it('should respect custom pollIntervalMs when polling for reappearance', () => {
      const mockWatcher2 = makeMockWatcher();
      let callCount = 0;
      vi.mocked(fs.watch).mockImplementation(
        (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
          const listener = typeof _optionsOrListener === 'function'
            ? _optionsOrListener
            : listenerArg;
          callCount++;
          if (callCount === 1) {
            mockWatcher._changeListener = listener;
            return mockWatcher as unknown as fs.FSWatcher;
          } else {
            mockWatcher2._changeListener = listener;
            return mockWatcher2 as unknown as fs.FSWatcher;
          }
        },
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 500 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);
      errorListener(makeErrnoError('ENOENT'));

      // Just under one 500ms poll interval — not yet reattached
      vi.advanceTimersByTime(499);
      expect(fs.watch).toHaveBeenCalledTimes(1);

      // Past it — reattach should happen
      vi.advanceTimersByTime(1);
      expect(fs.watch).toHaveBeenCalledTimes(2);

      watcher.close();
    });
  });

  // ── 6. Non-ENOENT error handling ────────────────────────────────────────────

  describe('non-ENOENT error handling', () => {
    it('should log warning when fs.watch throws EPERM on attach', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw makeErrnoError('EPERM', 'permission denied');
      });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('permission denied'),
        expect.objectContaining({ filePath: TEST_FILE, code: 'EPERM' }),
      );
      expect(watcher.isWatching).toBe(true); // still marked as watching
      watcher.close();
    });

    it('should NOT start polling when fs.watch throws a non-ENOENT error on attach', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw makeErrnoError('EPERM', 'permission denied');
      });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();

      // Advance time well beyond any poll interval — no re-attempts
      vi.advanceTimersByTime(10000);
      expect(callback).not.toHaveBeenCalled();
      watcher.close();
    });

    it('should log warning and detach when active watcher emits a non-ENOENT error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      // Non-ENOENT error from the active watcher
      errorListener(makeErrnoError('EIO', 'I/O error'));

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('EIO'),
        expect.objectContaining({ filePath: TEST_FILE }),
      );
      // The native watcher was detached
      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      watcher.close();
    });

    it('should start polling as fallback when active watcher emits a non-ENOENT error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();
      const errorListener = getErrorListener(mockWatcher);

      errorListener(makeErrnoError('EIO', 'I/O error'));

      // Polling should now be active — advance one interval
      vi.advanceTimersByTime(2000);
      // fs.watch still called only once (the initial attach; not a reattach yet
      // because existsSync returns false)
      expect(fs.watch).toHaveBeenCalledTimes(1);
      watcher.close();
    });
  });

  // ── 7. readMtime error handling ──────────────────────────────────────────────

  describe('readMtime error handling', () => {
    it('should return 0 silently (no logWarn) when statSync throws ENOENT on start', () => {
      // statSync called during attach baseline — throw ENOENT → returns 0 silently
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw makeErrnoError('ENOENT', 'no such file');
      });
      // fs.watch still succeeds
      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();

      const warnCalls = vi.mocked(logWarn).mock.calls;
      const statWarnCalls = warnCalls.filter((c: unknown[]) => String(c[0]).includes('stat failed'));
      expect(statWarnCalls).toHaveLength(0);

      watcher.close();
    });

    it('should return 0 and log warning when statSync throws EPERM during debounce check', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)  // baseline (succeeds)
        .mockImplementation(() => {
          throw makeErrnoError('EPERM', 'permission denied on stat');
        });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      // After debounce fires, readMtime throws EPERM → returns 0
      vi.advanceTimersByTime(300);

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('stat failed'),
        expect.objectContaining({ filePath: TEST_FILE }),
      );
      // Since mtime returns 0, checkAndFire bails out — callback NOT fired
      expect(callback).not.toHaveBeenCalled();
      watcher.close();
    });

    it('should return 0 and log warning when statSync throws EACCES during debounce check', () => {
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockImplementation(() => {
          throw makeErrnoError('EACCES', 'access denied');
        });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('stat failed'),
        expect.anything(),
      );
      watcher.close();
    });
  });

  // ── 8. Callback error handling ───────────────────────────────────────────────

  describe('callback error handling', () => {
    it('should catch and log a synchronous error thrown by the callback', () => {
      const syncThrowCallback: FileChangeCallback = vi.fn().mockImplementation(() => {
        throw new Error('sync callback failure');
      });

      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, syncThrowCallback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('sync callback failure'),
        expect.anything(),
      );
      watcher.close();
    });

    it('should NOT propagate a synchronous callback error', () => {
      const syncThrowCallback: FileChangeCallback = vi.fn().mockImplementation(() => {
        throw new Error('sync callback failure');
      });

      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, syncThrowCallback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);

      expect(() => {
        changeListener('change');
        vi.advanceTimersByTime(300);
      }).not.toThrow();

      watcher.close();
    });

    it('should catch and log an async rejection from the callback', async () => {
      const asyncRejectCallback: FileChangeCallback = vi.fn().mockReturnValue(
        Promise.reject(new Error('async callback rejection')),
      );

      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, asyncRejectCallback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);
      changeListener('change');

      vi.advanceTimersByTime(300);
      // Flush microtasks so the .catch() handler executes
      await Promise.resolve();

      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('async callback rejection'),
        expect.anything(),
      );
      watcher.close();
    });

    it('should NOT propagate an async callback rejection as an unhandled error', async () => {
      const asyncRejectCallback: FileChangeCallback = vi.fn().mockReturnValue(
        Promise.reject(new Error('async callback rejection')),
      );

      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtimeMs: BASE_MTIME } as fs.Stats)
        .mockReturnValue({ mtimeMs: BASE_MTIME + 1 } as fs.Stats);

      const watcher = new FileWatcher(TEST_FILE_REL, asyncRejectCallback);
      watcher.start();
      const changeListener = getChangeListener(mockWatcher);

      await expect(async () => {
        changeListener('change');
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      }).not.toThrow();

      watcher.close();
    });
  });

  // ── 9. File missing on start() ───────────────────────────────────────────────

  describe('file missing on start()', () => {
    it('should start polling immediately if file does not exist when start() is called', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw makeErrnoError('ENOENT', 'no such file or directory');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 2000 });
      watcher.start();

      // Advance past one poll interval — existsSync returns false, no reattach
      vi.advanceTimersByTime(2000);
      // Only the one initial (failed) fs.watch attempt
      expect(fs.watch).toHaveBeenCalledTimes(1);
      expect(callback).not.toHaveBeenCalled();

      watcher.close();
    });

    it('should set isWatching=true even when file is missing on start()', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw makeErrnoError('ENOENT', 'no such file or directory');
      });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();

      expect(watcher.isWatching).toBe(true);
      watcher.close();
    });

    it('should log debug message about polling when file is missing on start()', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw makeErrnoError('ENOENT', 'no such file or directory');
      });

      const watcher = new FileWatcher(TEST_FILE_REL, callback);
      watcher.start();

      expect(logDebug).toHaveBeenCalledWith(
        expect.stringContaining('polling'),
        expect.objectContaining({ filePath: TEST_FILE }),
      );
      watcher.close();
    });

    it('should attach watcher and fire callback when file appears after polling', () => {
      const mockWatcher2 = makeMockWatcher();
      let callCount = 0;

      vi.mocked(fs.watch).mockImplementation(
        (_filename: any, _optionsOrListener: any, listenerArg?: any) => {
          const listener = typeof _optionsOrListener === 'function'
            ? _optionsOrListener
            : listenerArg;
          callCount++;
          if (callCount === 1) {
            // First call — throw ENOENT (file missing)
            throw makeErrnoError('ENOENT', 'no such file');
          } else {
            // Second call — succeed (file reappeared)
            mockWatcher2._changeListener = listener;
            return mockWatcher2 as unknown as fs.FSWatcher;
          }
        },
      );

      vi.mocked(fs.existsSync).mockReturnValue(true); // file appears immediately on first poll

      const watcher = new FileWatcher(TEST_FILE_REL, callback, { pollIntervalMs: 1000 });
      watcher.start();

      vi.advanceTimersByTime(1000);

      expect(fs.watch).toHaveBeenCalledTimes(2); // initial (failed) + reattach
      expect(callback).toHaveBeenCalledTimes(1);

      watcher.close();
    });
  });
});
