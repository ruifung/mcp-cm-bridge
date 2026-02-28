/**
 * SessionResolver — encapsulates per-session executor management.
 *
 * Extracted from the closure logic inside `startCodeModeBridgeServer` in
 * server.ts so the session-to-executor mapping, idle timeout, race-condition
 * guard, and singleton management can be unit-tested independently.
 */

import type { Executor } from '../sandbox/executor/helpers/types.js';
import type { ExecutorInfo } from './executor.js';
import {SandboxManager} from "@/sandbox/manager.js";

// ── Public constants ───────────────────────────────────────────────────────

/** Default idle timeout: 30 minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Default executor creation timeout: 30 seconds. */
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30_000;

/**
 * Well-known session ID used for the singleton (default/fallback) executor.
 * Requests without a sessionId are routed to this session.
 */
export const SINGLETON_SESSION_ID = '__singleton__';

// ── Public types ──────────────────────────────────────────────────────────

/** Holds the per-session executor and its idle-timeout timer. */
export interface SessionState {
  executor: Executor;
  executorInfo: ExecutorInfo;
  lastActivity: number;
  /**
   * The idle-timeout timer handle, or null when the session is protected
   * from idle disposal (e.g. singleton in stdio mode).
   */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * When true the session is exempt from idle-timeout disposal.
   * The timer is never created and never reset on activity.
   */
  protected: boolean;
}

/**
 * Abstraction over the executor creation function.
 * Matches the partial-application pattern used in server.ts:
 *   `(timeout) => createExecutor(timeout, resolvedExecutorType)`
 */
export type ExecutorFactory = (
  timeout: number,
) => Promise<{ executor: Executor; info: ExecutorInfo }>;

/**
 * Optional logger interface. When omitted, the resolver operates silently
 * (ideal for unit tests). When provided, mirrors the project's logInfo/logError.
 */
export interface SessionResolverLogger {
  info: (message: string) => void;
  error: (message: string, details: unknown) => void;
}

export interface SessionResolverOptions {
  /** Factory that creates a fresh Executor instance. */
  createExecutor: ExecutorFactory;
  /** The pre-created singleton executor (created during server bootstrap). */
  initialExecutor: Executor;
  /** Info about the initial executor (type, reason, timeout). */
  initialExecutorInfo: ExecutorInfo;
  /** Whether the server is running in HTTP (multi-session) mode. */
  isHttpMode: boolean;
  /** Idle timeout in ms before a session executor is disposed. Defaults to DEFAULT_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Timeout passed to createExecutor when creating new executors. Defaults to 30000. */
  executorTimeout?: number;
  /** Optional logger. Silent when omitted (for tests). */
  log?: SessionResolverLogger;
}

// ── SessionResolver class ─────────────────────────────────────────────────

export class SessionResolver {
  private readonly _createExecutor: ExecutorFactory;
  private readonly _initialExecutorInfo: ExecutorInfo;
  private readonly _isHttpMode: boolean;
  private readonly _idleTimeoutMs: number;
  private readonly _executorTimeout: number;
  private readonly _log: SessionResolverLogger;

  private readonly _sessions = new Map<string, SessionState>();
  /**
   * Tracks in-flight session creations to prevent duplicate executor creation
   * under concurrent tool calls for the same new session (race-condition guard).
   */
  private readonly _sessionCreating = new Map<string, Promise<SessionState>>();

  constructor(options: SessionResolverOptions) {
    this._createExecutor = options.createExecutor;
    this._initialExecutorInfo = options.initialExecutorInfo;
    this._isHttpMode = options.isHttpMode;
    this._idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this._executorTimeout = options.executorTimeout ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
    this._log = options.log ?? { info: () => {}, error: () => {} };

    // Eagerly store the initial executor as the singleton session.
    // In stdio mode the singleton is protected (no idle timer).
    // In HTTP mode it participates in the normal idle-timeout cycle.
    const singletonProtected = !this._isHttpMode;
    this._sessions.set(SINGLETON_SESSION_ID, {
      executor: options.initialExecutor,
      executorInfo: options.initialExecutorInfo,
      lastActivity: Date.now(),
      idleTimer: null,
      protected: singletonProtected,
    });
  }

  // ── Core resolver ────────────────────────────────────────────────────────

  /**
   * Resolve the appropriate executor for a request.
   *
   * - sessionId is undefined/empty → routes to the singleton session
   * - sessionId is provided, session exists → resets idle timer, returns cached executor
   * - sessionId is provided, session missing → creates new executor (with race-condition guard)
   * - sessionId is provided, creation fails → falls back to singleton session
   */
  async resolve(sessionId?: string): Promise<Executor> {
    // Falsy sessionId → singleton path (single unified code path)
    const effectiveId = sessionId || SINGLETON_SESSION_ID;

    let session = this._sessions.get(effectiveId);
    if (!session) {
      // Lazy creation: first tool call for this session spins up a fresh executor.
      // Use _sessionCreating map to avoid duplicate executor creation under concurrency.
      if (!this._sessionCreating.has(effectiveId)) {
        this._log.info(`Creating executor for new session ${effectiveId}`);
        const promise = (async (): Promise<SessionState> => {
          const { executor, info } = await this._createExecutor(this._executorTimeout);
          const newSession: SessionState = {
            executor,
            executorInfo: info,
            lastActivity: Date.now(),
            idleTimer: null,
            protected: false,
          };
          // Arm the idle timer immediately for non-protected sessions
          this._armIdleTimer(effectiveId, newSession);
          this._sessions.set(effectiveId, newSession);
          this._sessionCreating.delete(effectiveId);
          return newSession;
        })();
        promise.catch(() => this._sessionCreating.delete(effectiveId)); // cleanup on failure
        this._sessionCreating.set(effectiveId, promise);
      }

      try {
        session = await this._sessionCreating.get(effectiveId)!;
      } catch (err) {
        this._log.error(
          `Failed to create executor for session ${effectiveId}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : { error: String(err) },
        );
        this._log.info(
          `Failed to create isolated executor for session ${effectiveId}, falling back to shared executor. Client isolation is NOT active for this session.`,
        );
        // Fall back to singleton. Re-create it if it was disposed by idle timeout.
        const singletonSession = this._sessions.get(SINGLETON_SESSION_ID);
        if (singletonSession) {
          this._resetIdleTimer(SINGLETON_SESSION_ID, singletonSession);
          return singletonSession.executor;
        }
        // Singleton itself was disposed — re-create it
        this._log.info('Singleton executor was disposed; re-creating on demand');
        const { executor } = await this._createExecutor(this._executorTimeout);
        const recreated: SessionState = {
          executor,
          executorInfo: this._initialExecutorInfo,
          lastActivity: Date.now(),
          idleTimer: null,
          protected: !this._isHttpMode,
        };
        this._armIdleTimer(SINGLETON_SESSION_ID, recreated);
        this._sessions.set(SINGLETON_SESSION_ID, recreated);
        return recreated.executor;
      }
    }

    // Reset the idle timer on every activity (no-op for protected sessions)
    this._resetIdleTimer(effectiveId, session);

    return session.executor;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /** Dispose a single session's executor and remove it from the session map. */
  async disposeSession(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    this._sessions.delete(sessionId);
    try {
      if (typeof (session.executor as any).dispose === 'function') {
        await (session.executor as any).dispose();
      }
    } catch (err) {
      this._log.error(
        `Error disposing executor for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : { error: String(err) },
      );
    }
    this._log.info(`Disposed executor for session ${sessionId}`);
  }

  /**
   * Dispose ALL sessions including the singleton executor. Intended for graceful shutdown.
   * After calling this, the resolver should not be used again.
   */
  async disposeAll(): Promise<void> {
    await Promise.all(
      Array.from(this._sessions.keys()).map((id) => this.disposeSession(id)),
    );
  }

  // ── Inspection API ────────────────────────────────────────────────────────

  /** Number of active sessions (including the singleton). */
  get sessionCount(): number {
    return this._sessions.size;
  }

  /** Whether a session with the given ID exists. */
  hasSession(sessionId: string): boolean {
    return this._sessions.has(sessionId);
  }

  /** Get the internal SessionState for a session (or undefined). */
  getSession(sessionId: string): SessionState | undefined {
    return this._sessions.get(sessionId);
  }

  /** Iterator over all active session IDs. */
  get sessionIds(): IterableIterator<string> {
    return this._sessions.keys();
  }

  /** The executor info from the initial/current singleton. */
  get executorInfo(): ExecutorInfo {
    return this._initialExecutorInfo;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Arm the idle timer for a session that was just created.
   * No-op for protected sessions (e.g. singleton in stdio mode).
   */
  private _armIdleTimer(sessionId: string, session: SessionState): void {
    if (session.protected) return;
    const timer = setTimeout(
      () => this.disposeSession(sessionId),
      this._idleTimeoutMs,
    );
    timer.unref();
    session.idleTimer = timer;
  }

  /**
   * Reset the idle timer for an existing session on activity.
   * No-op for protected sessions.
   */
  private _resetIdleTimer(sessionId: string, session: SessionState): void {
    if (session.protected) return;
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    session.lastActivity = Date.now();
    const timer = setTimeout(
      () => this.disposeSession(sessionId),
      this._idleTimeoutMs,
    );
    timer.unref();
    session.idleTimer = timer;
  }
}
