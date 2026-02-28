/**
 * Unit tests for the multi-client executor isolation feature.
 *
 * These tests exercise the SessionResolver class extracted from server.ts.
 * By injecting mock dependencies we can test the session-to-executor mapping,
 * race-condition guard, idle timeout, singleton management, and disposeSession
 * logic without any I/O or real executor creation.
 *
 * Section 5 tests a local `makeSessionAwareHandler` factory that mirrors the
 * `makeEvalHandler` pattern from server.ts — the session isolation concern
 * (each call dispatches to the executor resolved for its sessionId) is
 * verified against a fully-controllable mock.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Executor } from '../../src/executor/types.js';

// ── Module-level mocks (hoisted before imports) ────────────────────────────

vi.mock('../../src/utils/logger.js', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { SessionResolver, DEFAULT_IDLE_TIMEOUT_MS, SINGLETON_SESSION_ID } from '../../src/mcp/session-resolver.js';

// ── ExecutorResolver type (mirrors server.ts closure signature) ────────────
type ExecutorResolver = (sessionId?: string) => Promise<Executor>;

// ── Test helpers / fixtures ────────────────────────────────────────────────

/** Build a minimal Executor mock (with dispose extension for lifecycle tests) */
function makeMockExecutor() {
  return {
    execute: vi.fn().mockResolvedValue({ result: 'mock result', error: undefined }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/** Cast a session executor back to the mock shape for assertions. */
function asMock(executor: Executor) {
  return executor as ReturnType<typeof makeMockExecutor>;
}

/** Build a mock createExecutor factory that returns a fresh executor each call */
function makeMockCreateExecutor() {
  return vi.fn().mockImplementation(async () => ({
    executor: makeMockExecutor(),
    info: { type: 'vm2' as const, reason: 'explicit' as const, timeout: 30000 },
  }));
}

const IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;

// ══════════════════════════════════════════════════════════════════════════════
// 1. Session-to-executor mapping
// ══════════════════════════════════════════════════════════════════════════════

describe('Session-to-executor mapping', () => {
  let singleton: ReturnType<typeof makeMockExecutor>;
  let mockCreateExecutor: ReturnType<typeof makeMockCreateExecutor>;
  let resolver: SessionResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    singleton = makeMockExecutor();
    mockCreateExecutor = makeMockCreateExecutor();
    resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: singleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should return the singleton executor when sessionId is undefined', async () => {
    const executor = await resolver.resolve(undefined);
    expect(executor).toBe(singleton);
    expect(mockCreateExecutor).not.toHaveBeenCalled();
  });

  it('should create a new executor for a new session ID', async () => {
    await resolver.resolve('session-alpha');
    expect(mockCreateExecutor).toHaveBeenCalledOnce();
  });

  it('should return the same executor on repeated calls for the same session ID', async () => {
    const first = await resolver.resolve('session-bravo');
    const second = await resolver.resolve('session-bravo');

    expect(first).toBe(second);
    // createExecutor should only be called once — the second call reuses the cached session
    expect(mockCreateExecutor).toHaveBeenCalledOnce();
  });

  it('should create different executor instances for different session IDs', async () => {
    const executorA = await resolver.resolve('session-charlie');
    const executorB = await resolver.resolve('session-delta');

    expect(executorA).not.toBe(executorB);
    expect(mockCreateExecutor).toHaveBeenCalledTimes(2);
  });

  it('should fall back to singleton executor when executor creation fails', async () => {
    mockCreateExecutor.mockRejectedValueOnce(new Error('Container unavailable'));

    const result = await resolver.resolve('session-echo');

    expect(result).toBe(singleton);
  });

  it('should return the singleton for an empty string session ID', async () => {
    // An empty string is falsy — treated the same as undefined
    const executor = await resolver.resolve('');
    expect(executor).toBe(singleton);
    expect(mockCreateExecutor).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Race condition protection
// ══════════════════════════════════════════════════════════════════════════════

describe('Race condition protection', () => {
  let singleton: ReturnType<typeof makeMockExecutor>;
  let mockCreateExecutor: ReturnType<typeof makeMockCreateExecutor>;
  let resolver: SessionResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    singleton = makeMockExecutor();
    mockCreateExecutor = makeMockCreateExecutor();
    resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: singleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should create only one executor when concurrent calls arrive for the same new session', async () => {
    // Fire three concurrent resolve calls for the same brand-new session ID
    const [e1, e2, e3] = await Promise.all([
      resolver.resolve('session-foxtrot'),
      resolver.resolve('session-foxtrot'),
      resolver.resolve('session-foxtrot'),
    ]);

    expect(mockCreateExecutor).toHaveBeenCalledOnce();
    // All three callers must receive the same executor instance
    expect(e1).toBe(e2);
    expect(e2).toBe(e3);
  });

  it('should resolve all concurrent callers with the same executor instance', async () => {
    // Delay the executor creation so the promises truly overlap
    let resolveCreate!: (value: any) => void;
    const pendingCreate = new Promise<{ executor: Executor; info: any }>((res) => {
      resolveCreate = res;
    });
    const delayedExecutor = makeMockExecutor();
    mockCreateExecutor.mockReturnValueOnce(pendingCreate);

    // Kick off two concurrent calls
    const p1 = resolver.resolve('session-golf');
    const p2 = resolver.resolve('session-golf');

    // Resolve the pending creation
    resolveCreate({ executor: delayedExecutor, info: { type: 'vm2', reason: 'explicit', timeout: 30000 } });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(delayedExecutor);
    expect(r2).toBe(delayedExecutor);
    expect(mockCreateExecutor).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Idle timeout
// ══════════════════════════════════════════════════════════════════════════════

describe('Idle timeout', () => {
  let singleton: ReturnType<typeof makeMockExecutor>;
  let mockCreateExecutor: ReturnType<typeof makeMockCreateExecutor>;
  let resolver: SessionResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    singleton = makeMockExecutor();
    mockCreateExecutor = makeMockCreateExecutor();
    resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: singleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should dispose the session after the idle timeout expires', async () => {
    await resolver.resolve('session-hotel');
    const session = resolver.getSession('session-hotel')!;
    expect(session).toBeDefined();

    // Advance fake clock by IDLE_TIMEOUT_MS to fire the timer
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    // Session should be removed from the map
    expect(resolver.hasSession('session-hotel')).toBe(false);
    // dispose() on the executor should have been called
    expect(asMock(session.executor).dispose).toHaveBeenCalledOnce();
  });

  it('should reset the idle timer when a session is accessed again', async () => {
    await resolver.resolve('session-india');

    // Advance to just before timeout
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);

    // Activity: access the session again (timer resets)
    await resolver.resolve('session-india');

    // Advance another IDLE_TIMEOUT_MS - 1 ms (still within the new window)
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);

    // Session should still be alive because the timer was reset
    expect(resolver.hasSession('session-india')).toBe(true);
  });

  it('should dispose the session only after the reset timer expires', async () => {
    await resolver.resolve('session-juliet');
    const session = resolver.getSession('session-juliet')!;

    // Advance just before timeout and trigger activity to reset
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 5000);
    await resolver.resolve('session-juliet');

    // Advance just past the original timeout (before the reset timer fires)
    await vi.advanceTimersByTimeAsync(5001);
    expect(resolver.hasSession('session-juliet')).toBe(true);

    // Now advance past the reset timer
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(resolver.hasSession('session-juliet')).toBe(false);
    expect(asMock(session.executor).dispose).toHaveBeenCalledOnce();
  });

  it('should call unref() on the idle timer so it does not prevent process exit', async () => {
    // Intercept setTimeout to spy on the returned timer's unref method.
    // We wrap the global in a spy that decorates the return value.
    const realSetTimeout = globalThis.setTimeout;
    const unrefSpy = vi.fn();

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      const timer = realSetTimeout(fn, delay, ...args);
      // Wrap unref so we can observe calls
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefSpy();
        return originalUnref ? originalUnref() : timer;
      };
      return timer;
    });

    try {
      await resolver.resolve('session-kilo');
      // unref() should have been called at least once (on the initial idle timer)
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Session cleanup (disposeSession)
// ══════════════════════════════════════════════════════════════════════════════

describe('disposeSession', () => {
  let singleton: ReturnType<typeof makeMockExecutor>;
  let mockCreateExecutor: ReturnType<typeof makeMockCreateExecutor>;
  let resolver: SessionResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    singleton = makeMockExecutor();
    mockCreateExecutor = makeMockCreateExecutor();
    resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: singleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should remove the session from the sessions map', async () => {
    await resolver.resolve('session-lima');
    expect(resolver.hasSession('session-lima')).toBe(true);

    await resolver.disposeSession('session-lima');

    expect(resolver.hasSession('session-lima')).toBe(false);
  });

  it('should call executor.dispose() on the session executor', async () => {
    await resolver.resolve('session-mike');
    const session = resolver.getSession('session-mike')!;

    await resolver.disposeSession('session-mike');

    expect(asMock(session.executor).dispose).toHaveBeenCalledOnce();
  });

  it('should clear the idle timer when the session is disposed', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await resolver.resolve('session-november');
    const session = resolver.getSession('session-november')!;
    const timerId = session.idleTimer;

    clearTimeoutSpy.mockClear(); // ignore setup calls

    await resolver.disposeSession('session-november');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
  });

  it('should be a no-op when called with a non-existent session ID', async () => {
    // Must not throw
    await expect(resolver.disposeSession('session-oscar-nonexistent')).resolves.toBeUndefined();
  });

  it('should not dispose the same executor twice when called concurrently', async () => {
    await resolver.resolve('session-papa');
    const session = resolver.getSession('session-papa')!;

    await Promise.all([
      resolver.disposeSession('session-papa'),
      resolver.disposeSession('session-papa'),
    ]);

    // dispose() should only be called once — the second disposeSession is a no-op
    expect(asMock(session.executor).dispose).toHaveBeenCalledOnce();
  });

  it('should handle executor.dispose() throwing without propagating the error', async () => {
    mockCreateExecutor.mockResolvedValueOnce({
      executor: {
        execute: vi.fn(),
        dispose: vi.fn().mockRejectedValue(new Error('Dispose failed unexpectedly')),
      },
      info: { type: 'vm2', reason: 'explicit', timeout: 30000 },
    });

    await resolver.resolve('session-quebec');

    // Must not throw even when dispose() rejects
    await expect(resolver.disposeSession('session-quebec')).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Session-aware eval handler (mirrors makeEvalHandler from server.ts)
// ══════════════════════════════════════════════════════════════════════════════
//
// `makeEvalHandler` in server.ts is an inline closure, not exported. We test
// an equivalent local factory that captures the same session-isolation concern:
//   • Each invocation calls the ExecutorResolver with the sessionId from `extra`
//   • The resolved executor's execute() is called with the provided code
//   • Results are serialised into a content array
//   • Errors propagate as thrown exceptions (handled by MCP SDK)
//   • getDescriptors is called on every invocation (no stale cache)

/**
 * Minimal reproduction of the `makeEvalHandler` pattern from server.ts.
 * Takes an executor resolver and a descriptor getter; returns an async handler
 * compatible with McpServer.registerTool().
 */
function makeSessionAwareHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveExecutor: (sessionId?: string) => Promise<any>,
  getDescriptors: () => Record<string, { execute: (...args: any[]) => Promise<unknown> }>,
) {
  return async (args: { code?: string }, extra: { sessionId?: string } | undefined) => {
    const sessionId = extra?.sessionId as string | undefined;
    const executor = await resolveExecutor(sessionId);
    const descriptors = getDescriptors();

    const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, descriptor] of Object.entries(descriptors)) {
      fns[name] = descriptor.execute;
    }

    const executeResult = await executor.execute(args.code ?? '', fns);

    if (executeResult.error) {
      const logCtx = executeResult.logs?.length
        ? `\n\nConsole output:\n${executeResult.logs.join('\n')}`
        : '';
      throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
    }

    const output: Record<string, unknown> = { code: args.code ?? '', result: executeResult.result };
    if (executeResult.logs?.length) output.logs = executeResult.logs;
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
  };
}

describe('Session-aware eval handler (makeSessionAwareHandler)', () => {
  let mockExecutor: ReturnType<typeof makeMockExecutor>;
  let executorResolverSpy: ReturnType<typeof vi.fn<(sid?: string) => Promise<ReturnType<typeof makeMockExecutor>>>>;
  let mockGetDescriptors: ReturnType<typeof vi.fn<() => Record<string, { execute: (...a: any[]) => Promise<unknown> }>>>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockExecutor = makeMockExecutor();
    // Default: execute returns a successful result
    mockExecutor.execute.mockResolvedValue({ result: 'ok', error: undefined });

    executorResolverSpy = vi.fn<(sid?: string) => Promise<ReturnType<typeof makeMockExecutor>>>().mockResolvedValue(mockExecutor);
    mockGetDescriptors = vi.fn<() => Record<string, { execute: (...a: any[]) => Promise<unknown> }>>().mockReturnValue({ 'test__tool': { execute: vi.fn() } });
  });

  it('should call executorResolver with the sessionId from extra', async () => {
    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await handler({ code: 'return 42;' }, { sessionId: 'session-romeo' });

    expect(executorResolverSpy).toHaveBeenCalledWith('session-romeo');
  });

  it('should call executorResolver with undefined when extra has no sessionId', async () => {
    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await handler({ code: 'return 1;' }, {});

    expect(executorResolverSpy).toHaveBeenCalledWith(undefined);
  });

  it('should call executorResolver with undefined when extra is null/undefined', async () => {
    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await handler({ code: 'return 1;' }, undefined);

    expect(executorResolverSpy).toHaveBeenCalledWith(undefined);
  });

  it('should pass code to executor.execute()', async () => {
    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);
    const code = 'const x = 5; return x * 2;';

    await handler({ code }, { sessionId: 'session-sierra' });

    expect(mockExecutor.execute).toHaveBeenCalledWith(code, expect.any(Object));
  });

  it('should pass descriptor functions to executor.execute() as fns map', async () => {
    const toolExecuteFn = vi.fn().mockResolvedValue(undefined);
    const descriptors = {
      'service__list': { execute: toolExecuteFn },
      'service__get': { execute: vi.fn() },
    };
    mockGetDescriptors.mockReturnValue(descriptors);

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);
    await handler({ code: '' }, { sessionId: 'session-tango' });

    const fnsArg = mockExecutor.execute.mock.calls[0][1] as Record<string, unknown>;
    expect(fnsArg).toHaveProperty('service__list');
    expect(fnsArg).toHaveProperty('service__get');
  });

  it('should return a text content item with JSON-serialised output', async () => {
    mockExecutor.execute.mockResolvedValue({ result: { answer: 42 }, error: undefined });

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);
    const result = await handler({ code: 'return {answer: 42}' }, { sessionId: 'session-uniform' });

    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toEqual({ answer: 42 });
  });

  it('should include logs in output when executor returns them', async () => {
    mockExecutor.execute.mockResolvedValue({
      result: 'done',
      error: undefined,
      logs: ['hello from console'],
    });

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);
    const result = await handler({ code: '' }, { sessionId: 'session-victor' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.logs).toEqual(['hello from console']);
  });

  it('should throw when executor.execute() returns an error', async () => {
    mockExecutor.execute.mockResolvedValue({ result: undefined, error: 'SyntaxError: unexpected token' });

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await expect(handler({ code: 'invalid JS{' }, { sessionId: 'session-whiskey' }))
      .rejects.toThrow('Code execution failed: SyntaxError: unexpected token');
  });

  it('should include console output in thrown error when logs are present', async () => {
    mockExecutor.execute.mockResolvedValue({
      result: undefined,
      error: 'ReferenceError: x is not defined',
      logs: ['step 1', 'step 2'],
    });

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await expect(handler({ code: '' }, { sessionId: 'session-xray' }))
      .rejects.toThrow('Console output:');
  });

  it('should throw when executorResolver throws', async () => {
    executorResolverSpy.mockRejectedValueOnce(new Error('Executor pool exhausted'));

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await expect(handler({ code: '' }, { sessionId: 'session-yankee' }))
      .rejects.toThrow('Executor pool exhausted');
  });

  it('should call getDescriptors on every invocation (no stale descriptor cache)', async () => {
    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    await handler({}, { sessionId: 'session-zulu-1' });
    await handler({}, { sessionId: 'session-zulu-2' });
    await handler({}, { sessionId: 'session-zulu-3' });

    // getDescriptors called once per invocation so live-reloaded tools are picked up
    expect(mockGetDescriptors).toHaveBeenCalledTimes(3);
  });

  it('should dispatch different sessions to different executors via the resolver', async () => {
    const executorA = {
      execute: vi.fn().mockResolvedValue({ result: 'from-A', error: undefined }),
      dispose: vi.fn(),
    };
    const executorB = {
      execute: vi.fn().mockResolvedValue({ result: 'from-B', error: undefined }),
      dispose: vi.fn(),
    };
    executorResolverSpy
      .mockResolvedValueOnce(executorA)
      .mockResolvedValueOnce(executorB);

    const handler = makeSessionAwareHandler(executorResolverSpy, mockGetDescriptors);

    const r1 = await handler({ code: '' }, { sessionId: 'session-alpha' });
    const r2 = await handler({ code: '' }, { sessionId: 'session-beta' });

    // Verify each session hit a different executor
    expect(executorA.execute).toHaveBeenCalledOnce();
    expect(executorB.execute).toHaveBeenCalledOnce();

    const out1 = JSON.parse(r1.content[0].text);
    const out2 = JSON.parse(r2.content[0].text);
    expect(out1.result).toBe('from-A');
    expect(out2.result).toBe('from-B');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Singleton executor idle timeout
// ══════════════════════════════════════════════════════════════════════════════
//
// The singleton executor in HTTP mode receives the same 30-min idle timeout as
// per-session executors.  In stdio mode no timer is set — the singleton lives
// for the lifetime of the process.

describe('Singleton executor idle timeout', () => {
  let mockSingleton: ReturnType<typeof makeMockExecutor>;
  let mockCreateExecutor: ReturnType<typeof makeMockCreateExecutor>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSingleton = makeMockExecutor();
    mockCreateExecutor = makeMockCreateExecutor();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should dispose the singleton executor after the idle timeout in HTTP mode', async () => {
    const resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: mockSingleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });

    // Trigger activity so the idle timer is armed
    await resolver.resolve(undefined);
    expect(resolver.getSession(SINGLETON_SESSION_ID)?.executor).toBe(mockSingleton);

    // Advance fake clock by exactly IDLE_TIMEOUT_MS to fire the timer
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    expect(resolver.getSession(SINGLETON_SESSION_ID)?.executor ?? null).toBeNull();
    expect(mockSingleton.dispose).toHaveBeenCalledOnce();
  });

  it('should reset the singleton idle timer on each access in HTTP mode', async () => {
    const resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: mockSingleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });

    // Arm the timer with initial activity
    await resolver.resolve(undefined);

    // Advance to just before timeout
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);

    // Reset the timer with a second access
    await resolver.resolve(undefined);

    // Advance another IDLE_TIMEOUT_MS - 1 ms — still inside the new window
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);

    // Singleton should still be alive because the timer was reset
    expect(resolver.getSession(SINGLETON_SESSION_ID)?.executor).toBe(mockSingleton);
    expect(mockSingleton.dispose).not.toHaveBeenCalled();
  });

  it('should lazily re-create the singleton executor after it has been disposed by timeout', async () => {
    const resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: mockSingleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });

    // Arm and fire the idle timer
    await resolver.resolve(undefined);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(resolver.getSession(SINGLETON_SESSION_ID)?.executor ?? null).toBeNull();

    // Accessing the singleton again should trigger lazy re-creation
    const refreshedExecutor = await resolver.resolve(undefined);

    expect(mockCreateExecutor).toHaveBeenCalledOnce();
    expect(refreshedExecutor).not.toBeNull();
    expect(refreshedExecutor).toBe(resolver.getSession(SINGLETON_SESSION_ID)?.executor);
  });

  it('should NOT set an idle timer for the singleton in stdio mode', async () => {
    const resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: mockSingleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: false,
    });

    // Access the singleton — in stdio mode no timer should be armed
    await resolver.resolve(undefined);

    // Advance well past the would-be timeout
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);

    // Singleton must still be alive — no timer was set
    expect(resolver.getSession(SINGLETON_SESSION_ID)?.executor).toBe(mockSingleton);
    expect(mockSingleton.dispose).not.toHaveBeenCalled();
  });

  it('should call unref() on the singleton idle timer so it does not prevent process exit', async () => {
    const resolver = new SessionResolver({
      createExecutor: mockCreateExecutor,
      initialExecutor: mockSingleton,
      initialExecutorInfo: { type: 'vm2', reason: 'explicit', timeout: 30000 },
      isHttpMode: true,
    });

    // Intercept setTimeout to spy on the returned timer's unref method
    const realSetTimeout = globalThis.setTimeout;
    const unrefSpy = vi.fn();

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      const timer = realSetTimeout(fn, delay, ...args);
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefSpy();
        return originalUnref ? originalUnref() : timer;
      };
      return timer;
    });

    try {
      // Trigger the singleton path — resetSingletonIdleTimer should call unref()
      await resolver.resolve(undefined);
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
