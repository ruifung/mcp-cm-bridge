/**
 * Unit tests for ContainerSocketExecutor — metadata labels and heartbeat mechanism.
 *
 * Mocks Dockerode so no real Docker daemon is needed.  A ready signal is pushed
 * through the stdout PassThrough that demuxStream captures, completing init().
 */

import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Module-level mocks (hoisted before imports) ──────────────────────
vi.mock('dockerode');
vi.mock('../../src/utils/docker.js', () => ({
  resolveDockerSocketPath: vi.fn().mockReturnValue('/var/run/docker.sock'),
}));
vi.mock('../../src/utils/logger.js', () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/utils/env.js', () => ({
  isBun: vi.fn().mockReturnValue(false),
  isDeno: vi.fn().mockReturnValue(false),
}));
vi.mock('../../src/executor/wrap-code.js', () => ({
  wrapCode: vi.fn((code: string) => code),
}));

// ── Imports (after mocks) ────────────────────────────────────────────
import Docker from 'dockerode';
import { ContainerSocketExecutor } from '../../src/executor/container-socket-executor.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * A minimal Duplex-like stream that records write() calls.
 * The executor writes heartbeat JSON to this stream.
 */
class MockAttachStream extends EventEmitter {
  public writtenChunks: string[] = [];
  public writable = true;
  public readable = true;

  write(chunk: string | Buffer): boolean {
    this.writtenChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }

  end(): void {
    this.writable = false;
  }
}

/** Holds the stdout PassThrough captured by the demuxStream spy. */
let capturedStdoutPassThrough: any = null;

/**
 * Set up the complete Dockerode mock for one test.
 *
 * Returns the attach stream (records writes) and a spy on createContainer.
 * MUST be called before `new ContainerSocketExecutor(...)` so that the Docker
 * constructor mock is in place when the executor is instantiated.
 */
function buildDockerMock() {
  capturedStdoutPassThrough = null;

  const attachStream = new MockAttachStream();

  const mockContainer = {
    id: 'mock-container-abc123',
    attach: vi.fn().mockResolvedValue(attachStream),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    // wait() never resolves during the test — simulates a running container
    wait: vi.fn().mockReturnValue(new Promise(() => {})),
    inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const createContainerSpy = vi.fn().mockResolvedValue(mockContainer);

  // Image already present → skip pull
  const mockImage = {
    inspect: vi.fn().mockResolvedValue({}),
  };

  // demuxStream: capture the stdout PassThrough for ready-signal injection
  const mockModem = {
    demuxStream: vi.fn((stream: any, stdout: any, _stderr: any) => {
      capturedStdoutPassThrough = stdout;
    }),
    followProgress: vi.fn(),
    dial: vi.fn(),
    _isProxied: false,
  };

  vi.mocked(Docker).mockImplementation(function (this: any) {
    this.createContainer = createContainerSpy;
    this.getImage = vi.fn().mockReturnValue(mockImage);
    this.pull = vi.fn();
    this.modem = mockModem;
  } as any);

  return { attachStream, createContainerSpy };
}

/**
 * Push the `{ type: 'ready' }` line through the stdout PassThrough that
 * demuxStream has connected to the readline interface.
 */
function emitReadySignal(): void {
  if (capturedStdoutPassThrough) {
    capturedStdoutPassThrough.write(JSON.stringify({ type: 'ready' }) + '\n');
  }
}

/**
 * Wait long enough for all the sequential `await`s inside `_init()` to
 * run through to the `readyPromise` wait, without advancing fake timers.
 * Uses `setImmediate` which runs after the microtask queue is drained for
 * the current iteration — enough for 5+ chained resolved-promise awaits.
 */
function waitForInitToReachReadyWait(): Promise<void> {
  // Multiple setImmediate rounds to handle the chain of sequential awaits:
  // pullImage → createContainer → attach → start → demuxStream → readline
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => setImmediate(resolve)));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ContainerSocketExecutor — metadata labels', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call createContainer with codemode.host-pid label set to the host process PID', async () => {
    const { createContainerSpy } = buildDockerMock();
    const executor = new ContainerSocketExecutor({ image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      emitReadySignal();
      await initPromise;

      expect(createContainerSpy).toHaveBeenCalledTimes(1);
      const callArgs = createContainerSpy.mock.calls[0][0];
      expect(callArgs.Labels).toBeDefined();
      expect(callArgs.Labels['codemode.host-pid']).toBe(String(process.pid));
    } finally {
      executor.dispose();
    }
  });

  it('should call createContainer with codemode.created-at label as a valid ISO timestamp', async () => {
    const { createContainerSpy } = buildDockerMock();
    const executor = new ContainerSocketExecutor({ image: 'node:24-slim' });

    try {
      const before = new Date();
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      emitReadySignal();
      await initPromise;
      const after = new Date();

      const callArgs = createContainerSpy.mock.calls[0][0];
      const createdAt: string = callArgs.Labels['codemode.created-at'];
      expect(createdAt).toBeDefined();

      const parsed = new Date(createdAt);
      expect(isNaN(parsed.getTime())).toBe(false);        // valid date
      expect(parsed.toISOString()).toBe(createdAt);        // strict ISO format
      expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime());
    } finally {
      executor.dispose();
    }
  });
});

describe('ContainerSocketExecutor — heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should set heartbeatInterval (non-null) after successful init', async () => {
    buildDockerMock();
    const executor = new ContainerSocketExecutor({ image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      emitReadySignal();
      await initPromise;

      expect((executor as any).heartbeatInterval).not.toBeNull();
    } finally {
      executor.dispose();
    }
  });

  it('should send { type: "heartbeat" } via the exec stream every 5 seconds', async () => {
    // Only fake setInterval/clearInterval — leave setTimeout and setImmediate real
    // so the async init chain completes normally.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const { attachStream } = buildDockerMock();
    const executor = new ContainerSocketExecutor({ image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      emitReadySignal();
      await initPromise;

      // Clear any writes that happened during init
      attachStream.writtenChunks.length = 0;

      // Advance 5 seconds → one heartbeat fires
      vi.advanceTimersByTime(5000);
      expect(attachStream.writtenChunks).toHaveLength(1);
      expect(JSON.parse(attachStream.writtenChunks[0])).toEqual({ type: 'heartbeat' });

      // Advance another 5 seconds → second heartbeat
      vi.advanceTimersByTime(5000);
      expect(attachStream.writtenChunks).toHaveLength(2);
      expect(JSON.parse(attachStream.writtenChunks[1])).toEqual({ type: 'heartbeat' });
    } finally {
      executor.dispose();
    }
  });

  it('should clear heartbeatInterval (set to null) after dispose()', async () => {
    buildDockerMock();
    const executor = new ContainerSocketExecutor({ image: 'node:24-slim' });

    try {
      const initPromise = (executor as any).init();
      await waitForInitToReachReadyWait();
      emitReadySignal();
      await initPromise;

      // Interval is active after init
      expect((executor as any).heartbeatInterval).not.toBeNull();

      executor.dispose();

      expect((executor as any).heartbeatInterval).toBeNull();
    } finally {
      // dispose() already called — safe to call again (no-op)
    }
  });
});
