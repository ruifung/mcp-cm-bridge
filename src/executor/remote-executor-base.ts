/**
 * Abstract base class for executor implementations.
 *
 * Provides the shared scaffolding (init deduplication, message dispatching,
 * tool call handling, execute, dispose) so that concrete executors only need
 * to implement the transport-specific pieces:
 *
 *   - _init()         — spawn the process/container and wait for 'ready'
 *   - send()          — write a JSON message to the transport
 *   - onDisposeKill() — terminate the process/container after shutdown
 *
 * Template method hooks (optional overrides):
 *   - onDisposePrepare()  — called first in dispose() (e.g. clear heartbeat)
 *   - onDisposeCleanup()  — called after shutdown message (e.g. stream.end())
 *   - onBadJson()         — called when a non-JSON line arrives from the runtime
 *   - onFatalError()      — called when a fatal runner error is received
 */

import type { Executor, ExecuteResult } from './types.js';
import { wrapCode } from './wrap-code.js';
import type { HostMessage, RuntimeMessage, PendingExecution } from './remote-executor-types.js';
import { createInterface, type Interface } from 'node:readline';

export abstract class RemoteExecutorBase implements Executor {
  protected readonly timeout: number;
  protected readline: Interface | null = null;
  protected ready = false;
  protected readyResolve: (() => void) | null = null;
  protected readyReject: ((err: Error) => void) | null = null;
  protected pendingExecution: PendingExecution | null = null;
  protected initPromise: Promise<void> | null = null;

  constructor(timeout: number) {
    this.timeout = timeout;
  }

  // ── Init ──────────────────────────────────────────────────────────

  /**
   * Deduplication guard — prevents concurrent init calls.
   * Subclasses should call super.init() or use this directly via await this.init().
   */
  protected async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  /**
   * Subclass implements: spawn process/container, set up readline,
   * wait for the 'ready' signal from the runtime.
   */
  protected abstract _init(): Promise<void>;

  // ── Transport ─────────────────────────────────────────────────────

  /** Subclass implements: write a JSON line to the transport. */
  protected abstract send(msg: HostMessage): void;

  // ── Dispose hooks ─────────────────────────────────────────────────

  /**
   * Template method hook: called at the very start of dispose(), before the
   * shutdown message is sent. Use for pre-shutdown cleanup such as clearing
   * heartbeat intervals.
   */
  protected onDisposePrepare(): void {}

  /**
   * Template method hook: called after the shutdown message is sent, before
   * readline.close(). Use for stream-specific teardown (e.g. execStream.end()).
   */
  protected onDisposeCleanup(): void {}

  /**
   * Template method hook: called after readline.close() to terminate the
   * underlying process or container (e.g. SIGTERM/SIGKILL or container.stop()).
   */
  protected abstract onDisposeKill(): void;

  // ── Message handling ──────────────────────────────────────────────

  /**
   * Shared message dispatcher — parses a line of JSON from the runtime and
   * routes it to the appropriate handler. Subclasses wire their readline
   * 'line' event to this method.
   */
  protected handleMessage(line: string): void {
    if (!line.trim()) return;

    let msg: RuntimeMessage;
    try {
      msg = JSON.parse(line) as RuntimeMessage;
    } catch {
      this.onBadJson(line);
      return;
    }

    switch (msg.type) {
      case 'ready':
        if (this.readyResolve) {
          this.readyResolve();
        }
        break;

      case 'tool-call':
        void this.handleToolCall(msg);
        break;

      case 'result':
        if (this.pendingExecution?.id === msg.id) {
          clearTimeout(this.pendingExecution.timeoutHandle);
          this.pendingExecution.resolve({ result: msg.result, logs: msg.logs });
          this.pendingExecution = null;
        }
        break;

      case 'error':
        this.handleErrorMessage(msg);
        break;
    }
  }

  /**
   * Called when a non-JSON line arrives from the runtime. Override to add
   * executor-specific logging or error propagation.
   */
  protected onBadJson(line: string): void {
    process.stderr.write(`[executor] bad JSON from runtime: ${line}\n`);
  }

  /**
   * Dispatches an 'error' message from the runtime.
   *
   * Two shapes are possible:
   *   - Execution-scoped: { type, id, error, logs } — resolves pendingExecution
   *   - Fatal runner error: { type, error: { message, stack, name } } — calls onFatalError()
   */
  protected handleErrorMessage(msg: RuntimeMessage & { type: 'error' }): void {
    if ('id' in msg && typeof (msg as any).id === 'string') {
      // Execution-scoped error
      const execErr = msg as { type: 'error'; id: string; error: string; logs?: string[] };
      if (this.pendingExecution?.id === execErr.id) {
        clearTimeout(this.pendingExecution.timeoutHandle);
        this.pendingExecution.resolve({
          result: undefined,
          error: execErr.error,
          logs: execErr.logs,
        });
        this.pendingExecution = null;
      }
    } else {
      // Fatal runner error
      const fatalMsg = msg as { type: 'error'; error: { message: string; stack?: string; name?: string } };
      this.onFatalError(fatalMsg.error);
    }
  }

  /**
   * Called when a fatal runner error is received (i.e. the error message has
   * no execution id). The base implementation rejects the readiness promise
   * if still initializing. Subclasses may override to add logging and call
   * super.onFatalError(error) for the base behavior.
   */
  protected onFatalError(error: { message: string; stack?: string; name?: string }): void {
    if (this.readyReject) {
      this.readyReject(new Error(`Runtime fatal error: ${error.message}`));
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  // ── Tool call handling ────────────────────────────────────────────

  /** Fully shared tool call handler — dispatches host-side tool functions. */
  private async handleToolCall(msg: { id: string; name: string; args: unknown }): Promise<void> {
    if (!this.pendingExecution) {
      this.send({ type: 'tool-error', id: msg.id, error: 'No active execution context' });
      return;
    }

    const fn = this.pendingExecution.fns[msg.name];

    if (!fn) {
      this.send({
        type: 'tool-error',
        id: msg.id,
        error: `Tool '${msg.name}' not found. Available tools: ${Object.keys(this.pendingExecution.fns).join(', ')}`,
      });
      return;
    }

    try {
      const result = await fn(...(Array.isArray(msg.args) ? msg.args : [msg.args]));
      this.send({ type: 'tool-result', id: msg.id, result });
    } catch (err) {
      this.send({
        type: 'tool-error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Execute ───────────────────────────────────────────────────────

  /** Fully shared execute() — identical across all three executor implementations. */
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    await this.init();

    if (this.pendingExecution) {
      return { result: undefined, error: 'Another execution is already in progress' };
    }

    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wrappedCode = wrapCode(code);

    return new Promise<ExecuteResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingExecution?.id === id) {
          this.pendingExecution = null;
          resolve({ result: undefined, error: `Code execution timeout after ${this.timeout}ms` });
        }
      }, this.timeout);

      this.pendingExecution = { id, resolve, reject, fns, timeoutHandle };
      this.send({ type: 'execute', id, code: wrappedCode });
    });
  }

  // ── Dispose ───────────────────────────────────────────────────────

  /**
   * Template method dispose — shared choreography with hooks for differences.
   *
   * Order:
   *   1. Reject pending execution
   *   2. onDisposePrepare() hook (clear heartbeat, etc.)
   *   3. Send graceful shutdown message
   *   4. onDisposeCleanup() hook (stream teardown)
   *   5. Close readline
   *   6. onDisposeKill() hook (kill process / stop container)
   *   7. Reset state
   */
  dispose(): void {
    // 1. Reject pending execution
    if (this.pendingExecution) {
      clearTimeout(this.pendingExecution.timeoutHandle);
      this.pendingExecution.reject(new Error('Executor disposed'));
      this.pendingExecution = null;
    }

    // 2. Hook: pre-shutdown (clear heartbeat, etc.)
    this.onDisposePrepare();

    // 3. Send graceful shutdown message
    try { this.send({ type: 'shutdown' }); } catch { /* ignore */ }

    // 4. Hook: post-shutdown stream cleanup (execStream.end(), etc.)
    this.onDisposeCleanup();

    // 5. Close readline
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // 6. Hook: kill process / stop container
    this.onDisposeKill();

    // 7. Reset state
    this.ready = false;
    this.initPromise = null;
  }
}

// Re-export readline so subclasses don't need to import it separately
export { createInterface };
export type { Interface };
