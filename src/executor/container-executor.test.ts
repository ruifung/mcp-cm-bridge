/**
 * Unit tests for ContainerExecutor retry logic and failure handling.
 *
 * These tests mock ContainerSocketExecutor and ContainerCliExecutor at the
 * module level so the retry/backoff/fallback logic in ContainerExecutor
 * can be exercised without spinning up real Docker containers.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (hoisted before imports) ─────────────────────
vi.mock('./container-socket-executor.js', () => ({
  ContainerSocketExecutor: vi.fn(),
}));
vi.mock('./container-cli-executor.js', () => ({
  ContainerCliExecutor: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { ContainerExecutor } from './container-executor.js';
import { ContainerSocketExecutor } from './container-socket-executor.js';
import { ContainerCliExecutor } from './container-cli-executor.js';

// ── Mock factory ────────────────────────────────────────────────────

interface MockExecutor {
  init: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/**
 * Creates a plain mock executor object.
 *
 * initBehavior controls what `init()` does on each invocation:
 *   - 'success'  → always resolves
 *   - Error      → always rejects with that error
 *   - Error[]    → rejects once per element then resolves (per-instance counter)
 */
function createMockExecutor(
  initBehavior: 'success' | Error | Error[],
): MockExecutor {
  let callCount = 0;
  const errors = Array.isArray(initBehavior) ? [...initBehavior] : [];

  const initFn = vi.fn(async () => {
    if (initBehavior === 'success') return;
    if (Array.isArray(initBehavior)) {
      if (callCount < errors.length) {
        const err = errors[callCount++];
        throw err;
      }
      return; // all errors consumed → succeed
    }
    throw initBehavior; // single error — always fails
  });

  return {
    init: initFn,
    execute: vi.fn(async () => ({ result: 'mock-result' })),
    dispose: vi.fn(),
  };
}

/**
 * Installs ContainerSocketExecutor as a class-compatible constructor that
 * returns fresh mock instances.  Returns the instance list for assertions.
 *
 * The `factoryFn` is called for each `new ContainerSocketExecutor(...)` call
 * and must return a MockExecutor.  Default: always-success.
 */
function setupSocketMock(
  factoryFn?: () => MockExecutor,
): MockExecutor[] {
  const instances: MockExecutor[] = [];
  const factory = factoryFn ?? (() => createMockExecutor('success'));

  vi.mocked(ContainerSocketExecutor).mockImplementation(function (this: any) {
    const inst = factory();
    instances.push(inst);
    // Assign all properties to `this` so `new ContainerSocketExecutor()` returns them.
    Object.assign(this, inst);
  } as any);

  return instances;
}

/**
 * Installs ContainerCliExecutor as a class-compatible constructor.
 */
function setupCliMock(
  factoryFn?: () => MockExecutor,
): MockExecutor[] {
  const instances: MockExecutor[] = [];
  const factory = factoryFn ?? (() => createMockExecutor('success'));

  vi.mocked(ContainerCliExecutor).mockImplementation(function (this: any) {
    const inst = factory();
    instances.push(inst);
    Object.assign(this, inst);
  } as any);

  return instances;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ContainerExecutor retry logic', () => {
  let executor: ContainerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ContainerExecutor();
  });

  afterEach(() => {
    vi.useRealTimers();
    executor.dispose();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────

  it('should initialize successfully without retry on first attempt', async () => {
    const socketInstances = setupSocketMock(() => createMockExecutor('success'));
    setupCliMock(() => createMockExecutor('success')); // should never be used

    await executor.execute('return 1', {});

    // One socket instance created, init called once
    expect(socketInstances).toHaveLength(1);
    expect(socketInstances[0].init).toHaveBeenCalledTimes(1);
    // No disposal on the active executor
    expect(socketInstances[0].dispose).not.toHaveBeenCalled();
    // Underlying execute forwarded
    expect(socketInstances[0].execute).toHaveBeenCalledTimes(1);
    // CLI was never instantiated
    expect(vi.mocked(ContainerCliExecutor)).not.toHaveBeenCalled();
  });

  // ── 2. Retry on transient failure ─────────────────────────────────

  it('should retry and succeed on second attempt', async () => {
    vi.useFakeTimers();

    let socketCallCount = 0;
    const socketInstances = setupSocketMock(() => {
      // First call fails, second succeeds
      return createMockExecutor(
        socketCallCount++ === 0 ? new Error('transient socket error') : 'success',
      );
    });
    setupCliMock(); // fallback — should not be reached

    const initResult = executor.execute('return 1', {});
    await vi.runAllTimersAsync();
    await initResult;

    // Two socket instances: one failed, one succeeded
    expect(socketInstances).toHaveLength(2);
    // Failed instance was disposed
    expect(socketInstances[0].dispose).toHaveBeenCalledTimes(1);
    // Successful instance was not disposed
    expect(socketInstances[1].dispose).not.toHaveBeenCalled();
    // CLI was never needed
    expect(vi.mocked(ContainerCliExecutor)).not.toHaveBeenCalled();
  });

  // ── 3. Exhausts MAX_RETRIES then falls through to CLI ─────────────

  it('should retry up to MAX_RETRIES times then fall back to CLI in auto mode', async () => {
    vi.useFakeTimers();

    const socketInstances = setupSocketMock(() =>
      createMockExecutor(new Error('socket unavailable')),
    );
    const cliInstances = setupCliMock(() => createMockExecutor('success'));

    const initResult = executor.execute('return 1', {});
    await vi.runAllTimersAsync();
    await initResult;

    // Socket tried 3 times (MAX_RETRIES = 3)
    expect(socketInstances).toHaveLength(3);
    // CLI used as fallback — one instance, succeeded
    expect(cliInstances).toHaveLength(1);
    expect(cliInstances[0].execute).toHaveBeenCalledTimes(1);
  });

  // ── 4. Aggregate error contains all attempt details ────────────────

  it('should include all attempt error messages in aggregate error', async () => {
    vi.useFakeTimers();
    // Use mode='cli' so errors from CLI's initWithRetry surface directly
    const cliExecutor = new ContainerExecutor({ mode: 'cli' });

    let cliCallCount = 0;
    const attemptErrors = [
      new Error('container pull failed: image not found'),
      new Error('connection refused on /var/run/docker.sock'),
      new Error('permission denied: cannot start container'),
    ];
    setupCliMock(() => {
      const err = attemptErrors[cliCallCount % 3];
      cliCallCount++;
      return createMockExecutor(err);
    });

    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      cliExecutor.execute('return 1', {}).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    const { ok, err } = result as { ok: boolean; err: Error };
    expect(ok).toBe(false);
    expect(err.message).toContain('Attempt 1');
    expect(err.message).toContain('container pull failed');
    expect(err.message).toContain('Attempt 2');
    expect(err.message).toContain('connection refused');
    expect(err.message).toContain('Attempt 3');
    expect(err.message).toContain('permission denied');

    cliExecutor.dispose();
  });

  // ── 5. Dispose called on failed executor before retrying ──────────

  it('should dispose each failed executor instance before creating the next', async () => {
    vi.useFakeTimers();

    let socketCallCount = 0;
    const socketInstances = setupSocketMock(() => {
      // Fail twice, succeed on third attempt
      const behavior: Error | 'success' =
        socketCallCount++ < 2 ? new Error(`failure #${socketCallCount}`) : 'success';
      return createMockExecutor(behavior);
    });
    setupCliMock(); // fallback, should not be needed

    const initResult = executor.execute('return 1', {});
    await vi.runAllTimersAsync();
    await initResult;

    // 3 instances created: 2 failed + 1 success
    expect(socketInstances).toHaveLength(3);
    // Each failed instance was disposed before the next attempt
    expect(socketInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(socketInstances[1].dispose).toHaveBeenCalledTimes(1);
    // Successful instance was not disposed
    expect(socketInstances[2].dispose).not.toHaveBeenCalled();
  });

  // ── 6. Exponential backoff timing ─────────────────────────────────

  it('should apply exponential backoff between retries', async () => {
    vi.useFakeTimers();

    // Both socket and CLI always fail so all backoff timers fire
    setupSocketMock(() => createMockExecutor(new Error('socket unavailable')));
    setupCliMock(() => createMockExecutor(new Error('cli unavailable')));

    // Capture only the positive-delay setTimeout calls (backoff timers)
    const backoffDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (typeof delay === 'number' && delay > 0) {
        backoffDelays.push(delay);
      }
      return origSetTimeout(fn, delay, ...args);
    });

    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      executor.execute('return 1', {}).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    expect((result as { ok: boolean }).ok).toBe(false);

    // BASE_BACKOFF_MS=500 (attempt 1→2), BASE_BACKOFF_MS*2=1000 (attempt 2→3)
    // Both socket and CLI attempt 2 retries each (3 attempts → 2 backoff waits per executor)
    expect(backoffDelays).toContain(500);
    expect(backoffDelays).toContain(1000);
  });

  // ── 7. Socket-to-CLI fallback in auto mode ─────────────────────────

  it('should fall back from socket to CLI when socket retries are exhausted', async () => {
    vi.useFakeTimers();

    const socketInstances = setupSocketMock(() =>
      createMockExecutor(new Error('socket failed')),
    );
    const cliInstances = setupCliMock(() => createMockExecutor('success'));

    const autoExecutor = new ContainerExecutor({ mode: 'auto' });
    const initResult = autoExecutor.execute('return 1', {});
    await vi.runAllTimersAsync();
    await initResult;

    // All 3 socket retries attempted
    expect(socketInstances).toHaveLength(3);
    // CLI was used as fallback
    expect(cliInstances).toHaveLength(1);
    expect(cliInstances[0].execute).toHaveBeenCalledTimes(1);

    autoExecutor.dispose();
  });

  // ── 8. No CLI fallback when mode='socket' ─────────────────────────

  it('should not fall back to CLI when mode is socket', async () => {
    vi.useFakeTimers();

    setupSocketMock(() => createMockExecutor(new Error('socket failed')));
    setupCliMock(); // should never be used

    const socketOnlyExecutor = new ContainerExecutor({ mode: 'socket' });
    const initResult = socketOnlyExecutor.execute('return 1', {});

    // Drain timers and consume rejection together so it never leaks.
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      initResult.then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    expect((result as { ok: boolean; err: Error }).ok).toBe(false);
    expect((result as { ok: boolean; err: Error }).err.message).toMatch(/socket/i);
    // CLI must never be instantiated
    expect(vi.mocked(ContainerCliExecutor)).not.toHaveBeenCalled();

    socketOnlyExecutor.dispose();
  });

  // ── 9. CLI-only mode bypasses socket ──────────────────────────────

  it('should not try socket executor when mode is cli', async () => {
    const cliInstances = setupCliMock(() => createMockExecutor('success'));

    const cliOnlyExecutor = new ContainerExecutor({ mode: 'cli' });
    await cliOnlyExecutor.execute('return 1', {});

    // Socket constructor must never be called
    expect(vi.mocked(ContainerSocketExecutor)).not.toHaveBeenCalled();
    // CLI was used directly
    expect(cliInstances).toHaveLength(1);
    expect(cliInstances[0].init).toHaveBeenCalledTimes(1);

    cliOnlyExecutor.dispose();
  });

  // ── 10. initPromise resets after total failure ─────────────────────

  it('resets initPromise after total failure, allowing fresh retry', async () => {
    vi.useFakeTimers();

    // Arrange: start with CLI always failing
    let cliShouldFail = true;
    const cliInstances = setupCliMock(() =>
      createMockExecutor(cliShouldFail ? new Error('init failed') : 'success'),
    );
    setupSocketMock(() => createMockExecutor(new Error('socket unavailable')));

    const cliOnlyExecutor = new ContainerExecutor({ mode: 'cli' });

    // Act: first attempt should exhaust all retries and fail
    const firstAttempt = cliOnlyExecutor.execute('return 1', {}).then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err }),
    );
    await vi.runAllTimersAsync();
    const firstResult = await firstAttempt;
    expect((firstResult as { ok: boolean }).ok).toBe(false);

    // Now allow CLI to succeed
    cliShouldFail = false;

    // Act: second attempt should succeed WITHOUT calling dispose() first
    const secondAttempt = cliOnlyExecutor.execute('return 1', {}).then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err }),
    );
    await vi.runAllTimersAsync();
    const secondResult = await secondAttempt;
    expect((secondResult as { ok: boolean }).ok).toBe(true);

    // Successful CLI instance used for second attempt
    const successInstance = cliInstances[cliInstances.length - 1];
    expect(successInstance.execute).toHaveBeenCalledTimes(1);

    cliOnlyExecutor.dispose();
  });
});

// ── Group 2: Enhanced failure handling ─────────────────────────────

describe('ContainerExecutor failure handling', () => {
  let executor: ContainerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    // mode='cli' gives a single-layer error path for deterministic assertions
    executor = new ContainerExecutor({ mode: 'cli' });
  });

  afterEach(() => {
    vi.useRealTimers();
    executor.dispose();
  });

  // ── 10. Premature container exit surfaces stderr ───────────────────

  it('should surface stderr content in error when container exits prematurely', async () => {
    vi.useFakeTimers();

    setupCliMock(() =>
      createMockExecutor(
        new Error(
          'Container exited prematurely with code 137.\nStderr:\nkilled by OOM killer',
        ),
      ),
    );

    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      executor.execute('return 1', {}).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    const { ok, err } = result as { ok: boolean; err: Error };
    expect(ok).toBe(false);
    expect(err.message).toContain('Container exited prematurely');
    expect(err.message).toContain('OOM killer');
  });

  // ── 11. Non-JSON container output reported in error ────────────────

  it('should surface non-JSON container output in error when container crashes', async () => {
    vi.useFakeTimers();

    setupCliMock(() =>
      createMockExecutor(
        new Error('Container sent non-JSON output: Segmentation fault (core dumped)'),
      ),
    );

    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      executor.execute('return 1', {}).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    const { ok, err } = result as { ok: boolean; err: Error };
    expect(ok).toBe(false);
    expect(err.message).toContain('Container sent non-JSON output');
    expect(err.message).toContain('Segmentation fault');
  });

  // ── 12. Fatal runner error reported in error message ──────────────

  it('should surface fatal runner error in the aggregate error message', async () => {
    vi.useFakeTimers();

    setupCliMock(() =>
      createMockExecutor(
        new Error(
          'Container runner fatal error: Uncaught RangeError: Maximum call stack size exceeded',
        ),
      ),
    );

    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      executor.execute('return 1', {}).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, err }),
      ),
    ]);

    const { ok, err } = result as { ok: boolean; err: Error };
    expect(ok).toBe(false);
    expect(err.message).toContain('Container runner fatal error');
    expect(err.message).toContain('Maximum call stack size exceeded');
  });

  // ── 13. dispose() cleans up the active executor ───────────────────

  it('should call dispose on the active executor when ContainerExecutor.dispose() is called', async () => {
    const cliInstances = setupCliMock(() => createMockExecutor('success'));

    await executor.execute('return 1', {});
    expect(cliInstances).toHaveLength(1);
    expect(cliInstances[0].dispose).not.toHaveBeenCalled();

    executor.dispose();

    expect(cliInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  // ── 14. Can re-initialize after dispose ───────────────────────────

  it('should create a new executor and re-initialize after dispose', async () => {
    const cliInstances = setupCliMock(() => createMockExecutor('success'));

    // First initialization
    await executor.execute('return 1', {});
    expect(cliInstances).toHaveLength(1);

    // Dispose resets internal state
    executor.dispose();
    expect(cliInstances[0].dispose).toHaveBeenCalledTimes(1);

    // Second execute() must trigger a fresh initialization
    await executor.execute('return 2', {});

    // A new CLI instance must have been created
    expect(cliInstances).toHaveLength(2);
    expect(cliInstances[1].init).toHaveBeenCalledTimes(1);
    expect(cliInstances[1].execute).toHaveBeenCalledTimes(1);
  });

  // ── 15. dispose() on failed executor is a safe no-op ─────────────

  it('dispose on failed executor does not throw', async () => {
    vi.useFakeTimers();

    setupCliMock(() => createMockExecutor(new Error('init always fails')));

    // Trigger a failed initialization
    const attempt = executor.execute('return 1', {}).then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err }),
    );
    await vi.runAllTimersAsync();
    const result = await attempt;
    expect((result as { ok: boolean }).ok).toBe(false);

    // dispose() on a never-initialized executor must not throw
    expect(() => executor.dispose()).not.toThrow();
  });
});
