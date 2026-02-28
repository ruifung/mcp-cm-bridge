/**
 * Unit tests for the multi-client executor isolation feature.
 *
 * These tests exercise the SessionResolver class extracted from server.ts.
 * By injecting mock dependencies we can test the session-to-executor mapping,
 * race-condition guard, idle timeout, singleton management, and disposeSession
 * logic without any I/O or real executor creation.
 *
 * `createSessionAwareToolHandler` IS exported from mcp-adapter.ts and is
 * tested directly against the real module.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Executor } from '@cloudflare/codemode';

// ── Module-level mocks (hoisted before imports) ────────────────────────────

vi.mock('../../src/utils/logger.js', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('@cloudflare/codemode/ai', () => ({
  createCodeTool: vi.fn(),
}));

import { createSessionAwareToolHandler, type ExecutorResolver } from '../../src/mcp/mcp-adapter.js';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { SessionResolver, DEFAULT_IDLE_TIMEOUT_MS, SINGLETON_SESSION_ID } from '../../src/mcp/session-resolver.js';

// ── Test helpers / fixtures ────────────────────────────────────────────────

/** Build a minimal Executor mock */
function makeMockExecutor(): Executor & { dispose: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn().mockResolvedValue('mock result'),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as any;
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
    expect(session.executor.dispose).toHaveBeenCalledOnce();
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
    expect(session.executor.dispose).toHaveBeenCalledOnce();
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

    expect(session.executor.dispose).toHaveBeenCalledOnce();
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
    expect(session.executor.dispose).toHaveBeenCalledOnce();
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
// 5. createSessionAwareToolHandler
// ══════════════════════════════════════════════════════════════════════════════

/** Narrow a CallToolResult content item to a text item and return its text. */
function getTextContent(result: Awaited<ReturnType<ReturnType<typeof createSessionAwareToolHandler>>>, index = 0): string {
  const item = result.content[index];
  if (item.type !== 'text') throw new Error(`Expected text content at index ${index}, got ${item.type}`);
  return (item as { type: 'text'; text: string }).text;
}

describe('createSessionAwareToolHandler', () => {
  let mockExecutorResolver: ExecutorResolver;
  let mockExecutor: ReturnType<typeof makeMockExecutor>;
  let mockGetDescriptors: ReturnType<typeof vi.fn>;
  let mockToolExecute: ReturnType<typeof vi.fn>;
  // Keep a typed spy handle so we can set return values per test
  let executorResolverSpy: ReturnType<typeof vi.fn<ExecutorResolver>>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockExecutor = makeMockExecutor();
    executorResolverSpy = vi.fn<ExecutorResolver>().mockResolvedValue(mockExecutor);
    mockExecutorResolver = executorResolverSpy as unknown as ExecutorResolver;
    mockGetDescriptors = vi.fn().mockReturnValue({ 'test__tool': {} });

    // createCodeTool is mocked at the module level; set up what it returns here
    mockToolExecute = vi.fn().mockResolvedValue({ status: 'ok', data: [1, 2, 3] });
    vi.mocked(createCodeTool).mockReturnValue({
      description: 'test tool',
      execute: mockToolExecute,
      inputSchema: {} as any,
    } as any);
  });

  it('should call executorResolver with the sessionId from extra', async () => {
    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);

    await handler({ code: 'return 42;' }, { sessionId: 'session-romeo' });

    expect(executorResolverSpy).toHaveBeenCalledWith('session-romeo');
  });

  it('should call executorResolver with undefined when extra has no sessionId', async () => {
    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);

    await handler({ code: 'return 1;' }, {});

    expect(executorResolverSpy).toHaveBeenCalledWith(undefined);
  });

  it('should call executorResolver with undefined when extra is null/undefined', async () => {
    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);

    await handler({ code: 'return 1;' }, undefined);

    expect(executorResolverSpy).toHaveBeenCalledWith(undefined);
  });

  it('should pass args to the tool execute function', async () => {
    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const toolArgs = { code: 'const x = 5; return x * 2;', timeout: 5000 };

    await handler(toolArgs, { sessionId: 'session-sierra' });

    expect(mockToolExecute).toHaveBeenCalledWith(toolArgs);
  });

  it('should create a fresh codemode tool using the resolved executor and current descriptors', async () => {
    const descriptors = { 'service__list': {}, 'service__get': {} };
    mockGetDescriptors.mockReturnValue(descriptors);

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    await handler({ code: '' }, { sessionId: 'session-tango' });

    expect(vi.mocked(createCodeTool)).toHaveBeenCalledWith({
      tools: descriptors,
      executor: mockExecutor,
    });
  });

  it('should return a string result directly in the content text', async () => {
    mockToolExecute.mockResolvedValueOnce('execution output string');

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const result = await handler({ code: '' }, { sessionId: 'session-uniform' });

    expect(result.content[0].type).toBe('text');
    expect(getTextContent(result)).toBe('execution output string');
  });

  it('should JSON-serialize non-string results', async () => {
    mockToolExecute.mockResolvedValueOnce({ answer: 42, items: ['a', 'b'] });

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const result = await handler({ code: '' }, { sessionId: 'session-victor' });

    expect(result.content[0].type).toBe('text');
    expect(getTextContent(result)).toBe(JSON.stringify({ answer: 42, items: ['a', 'b'] }, null, 2));
  });

  it('should return an error message when executorResolver throws', async () => {
    executorResolverSpy.mockRejectedValueOnce(new Error('Executor pool exhausted'));

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const result = await handler({ code: '' }, { sessionId: 'session-whiskey' });

    expect(result.content[0].type).toBe('text');
    expect(getTextContent(result)).toContain('Executor pool exhausted');
  });

  it('should return an error message when tool execute throws', async () => {
    mockToolExecute.mockRejectedValueOnce(new Error('Syntax error in user code'));

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const result = await handler({ code: 'invalid JS{' }, { sessionId: 'session-xray' });

    expect(result.content[0].type).toBe('text');
    expect(getTextContent(result)).toContain('Syntax error in user code');
  });

  it('should prefix error text with "Tool execution failed:" on error', async () => {
    mockToolExecute.mockRejectedValueOnce(new Error('OOM'));

    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);
    const result = await handler({ code: '' }, { sessionId: 'session-yankee' });

    expect(getTextContent(result)).toMatch(/^Tool execution failed:/);
  });

  it('should call getDescriptors on every invocation (not caching stale descriptors)', async () => {
    const handler = createSessionAwareToolHandler(mockExecutorResolver, mockGetDescriptors);

    await handler({}, { sessionId: 'session-zulu-1' });
    await handler({}, { sessionId: 'session-zulu-2' });
    await handler({}, { sessionId: 'session-zulu-3' });

    // getDescriptors called once per invocation so live-reloaded tools are picked up
    expect(mockGetDescriptors).toHaveBeenCalledTimes(3);
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
