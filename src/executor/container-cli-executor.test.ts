/**
 * Unit tests for ContainerCliExecutor — metadata labels and heartbeat mechanism.
 *
 * Mocks child_process.spawn so no real Docker/Podman daemon is needed.
 * A ready signal is pushed through the mock stdout PassThrough so init() completes.
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

// ── Module-level mocks (hoisted before imports) ──────────────────────
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(), // used by detectRuntime (bypassed via runtime option) and pullImage
}));
vi.mock('../utils/logger.js', () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../utils/env.js', () => ({
  isBun: vi.fn().mockReturnValue(false),
  isDeno: vi.fn().mockReturnValue(false),
}));
vi.mock('./wrap-code.js', () => ({
  wrapCode: vi.fn((code: string) => code),
}));

// ── Imports (after mocks) ────────────────────────────────────────────
import { spawn, execFileSync } from 'node:child_process';
import { ContainerCliExecutor } from './container-cli-executor.js';

// ── Mock child process factory ────────────────────────────────────────

/**
 * A minimal mock ChildProcess.
 *
 * - `stdin` — writable interface that records write() calls
 * - `stdout` — PassThrough stream (readable by readline)
 * - `stderr` — PassThrough stream
 */
class MockChildProcess extends EventEmitter {
  public stdin: {
    writable: boolean;
    write: ReturnType<typeof vi.fn>;
  };
  public stdout: PassThrough;
  public stderr: PassThrough;
  public kill: ReturnType<typeof vi.fn>;

  constructor() {
    super();
    this.stdin = {
      writable: true,
      write: vi.fn().mockReturnValue(true),
    };
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kill = vi.fn();
  }

  /** Push a line of JSON to stdout (simulates container output). */
  emitStdoutLine(line: string): void {
    this.stdout.push(line + '\n');
  }
}

/**
 * Configure the spawn and execFileSync mocks, then return the mock process.
 * MUST be called before `new ContainerCliExecutor(...)`.
 *
 * execFileSync stub:
 *   - `image inspect` → returns empty Buffer (image already present, skip pull)
 *   - everything else → returns empty Buffer
 *
 * spawn stub → returns the mock process for both the image-pull path and the
 * container-run path (image inspect succeeds, so pull is never called here).
 */
function buildCliMock(): MockChildProcess {
  const mockProcess = new MockChildProcess();

  vi.mocked(execFileSync).mockImplementation((_cmd: any, args: any) => {
    // pullImage: docker image inspect <image> → succeed (image present, skip pull)
    return Buffer.from('');
  });

  vi.mocked(spawn).mockReturnValue(mockProcess as any);

  return mockProcess;
}

/**
 * Wait long enough for all sequential awaits inside `_init()` to run through
 * to the readyPromise wait.  Uses multiple setImmediate rounds to drain the
 * microtask queue across the async chain: pullImage → spawn → readline setup.
 */
function waitForInitToReachReadyWait(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => setImmediate(resolve)));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ContainerCliExecutor — metadata labels', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should pass --label codemode.host-pid=<pid> as consecutive spawn args', async () => {
    const mockProcess = buildCliMock();
    // Pass runtime explicitly to skip detectRuntime's execFileSync call
    const executor = new ContainerCliExecutor({ runtime: 'docker', image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      mockProcess.emitStdoutLine(JSON.stringify({ type: 'ready' }));
      await initPromise;

      expect(vi.mocked(spawn)).toHaveBeenCalled();
      const spawnArgs: string[] = vi.mocked(spawn).mock.calls[0][1] as string[];

      // Find '--label' immediately followed by the pid label value
      const pidLabelIndex = spawnArgs.findIndex(
        (arg, idx) =>
          arg === '--label' && spawnArgs[idx + 1] === `codemode.host-pid=${process.pid}`
      );
      expect(pidLabelIndex).toBeGreaterThanOrEqual(0);
      expect(spawnArgs[pidLabelIndex + 1]).toBe(`codemode.host-pid=${process.pid}`);
    } finally {
      executor.dispose();
    }
  });

  it('should pass --label codemode.created-at=<iso-timestamp> as consecutive spawn args', async () => {
    const mockProcess = buildCliMock();
    const executor = new ContainerCliExecutor({ runtime: 'docker', image: 'node:24-slim' });

    try {
      const before = new Date();
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      mockProcess.emitStdoutLine(JSON.stringify({ type: 'ready' }));
      await initPromise;
      const after = new Date();

      const spawnArgs: string[] = vi.mocked(spawn).mock.calls[0][1] as string[];

      // Find the value arg after '--label' that starts with 'codemode.created-at='
      const createdAtEntry = spawnArgs.find(
        (arg, idx) =>
          spawnArgs[idx - 1] === '--label' && arg.startsWith('codemode.created-at=')
      );
      expect(createdAtEntry).toBeDefined();

      const isoTimestamp = createdAtEntry!.replace('codemode.created-at=', '');
      const parsed = new Date(isoTimestamp);
      expect(isNaN(parsed.getTime())).toBe(false);        // valid date
      expect(parsed.toISOString()).toBe(isoTimestamp);     // strict ISO format
      expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime());
    } finally {
      executor.dispose();
    }
  });
});

describe('ContainerCliExecutor — heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should set heartbeatInterval (non-null) after successful init', async () => {
    const mockProcess = buildCliMock();
    const executor = new ContainerCliExecutor({ runtime: 'docker', image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      mockProcess.emitStdoutLine(JSON.stringify({ type: 'ready' }));
      await initPromise;

      expect((executor as any).heartbeatInterval).not.toBeNull();
    } finally {
      executor.dispose();
    }
  });

  it('should send { type: "heartbeat" } via process.stdin.write every 5 seconds', async () => {
    // Only fake setInterval/clearInterval so the async init chain works normally
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const mockProcess = buildCliMock();
    const executor = new ContainerCliExecutor({ runtime: 'docker', image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      mockProcess.emitStdoutLine(JSON.stringify({ type: 'ready' }));
      await initPromise;

      // Clear any writes that happened during init (none expected but be safe)
      mockProcess.stdin.write.mockClear();

      // Advance 5 seconds → one heartbeat fires
      vi.advanceTimersByTime(5000);
      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(1);
      const firstCall = mockProcess.stdin.write.mock.calls[0][0] as string;
      expect(JSON.parse(firstCall)).toEqual({ type: 'heartbeat' });

      // Advance another 5 seconds → second heartbeat
      vi.advanceTimersByTime(5000);
      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(2);
      const secondCall = mockProcess.stdin.write.mock.calls[1][0] as string;
      expect(JSON.parse(secondCall)).toEqual({ type: 'heartbeat' });
    } finally {
      executor.dispose();
    }
  });

  it('should clear heartbeatInterval (set to null) after dispose()', async () => {
    const mockProcess = buildCliMock();
    const executor = new ContainerCliExecutor({ runtime: 'docker', image: 'node:24-slim' });

    const initPromise = (executor as any).init();
    await waitForInitToReachReadyWait();
    mockProcess.emitStdoutLine(JSON.stringify({ type: 'ready' }));
    await initPromise;

    // Interval is active after init
    expect((executor as any).heartbeatInterval).not.toBeNull();

    executor.dispose();

    expect((executor as any).heartbeatInterval).toBeNull();
  });
});
