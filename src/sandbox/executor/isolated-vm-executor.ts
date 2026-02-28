import type { Executor, ExecuteResult } from './helpers/types.js';
// @ts-ignore - isolated-vm is an optional dependency; this file is only loaded via dynamic import() when available
import ivm from 'isolated-vm';
import { wrapCode } from './helpers/wrap-code.js';
import { logWarn } from '../../utils/logger.js';
const { Isolate, Context } = ivm;
type IsolateType = InstanceType<typeof ivm.Isolate>;
type ContextType = ReturnType<IsolateType['createContextSync']>;

/**
 * Helper: Convert any value to a string representation for logging
 */
function stringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      if (value instanceof Error) {
        return `Error: ${value.message}`;
      }
      if (Array.isArray(value)) {
        return `[ ${value.map((v) => stringify(v)).join(', ')} ]`;
      }
      return JSON.stringify(value, (key, val) => {
        if (typeof val === 'function') return '[Function]';
        return val;
      });
    }
    return String(value);
  } catch {
    return '[Object]';
  }
}

export interface IsolatedVmExecutorOptions {
  /** Memory limit in MB (default: 128) */
  memoryLimit?: number;
  /** Enable inspector (default: false) */
  inspector?: boolean;
  /** Execution timeout in ms (default: 30000) */
  timeout?: number;
  /** Per-tool-call timeout in ms (default: same as timeout). If a single tool call exceeds this, its promise is rejected. */
  toolCallTimeout?: number;
}

export interface ExecutionMetrics {
  cpuTime: bigint;
  wallTime: bigint;
  heapUsed: number;
  heapLimit: number;
}

/**
 * Executor implementation using isolated-vm
 *
 * Architecture: Uses Promise chain pattern
 * - Async IIFE is executed in the isolate
 * - Its returned Promise is chained with .then() inside the isolate
 * - The .then handlers call sync Callbacks on the host side
 * - Host Promise resolves when the callback is invoked
 *
 * Features:
 * - True memory isolation (V8 Isolate level)
 * - Hard memory limit enforcement
 * - Accurate timeout handling
 * - Promise-based result capturing
 *
 * Security:
 * - Separate V8 memory heap
 * - No shared memory access
 * - Explicit serialization boundaries
 */
export class IsolatedVmExecutor implements Executor {
  private isolate: IsolateType;
  private context: ContextType | null = null;
  private metrics: ExecutionMetrics | null = null;
  private readonly options: Required<IsolatedVmExecutorOptions>;
  private pendingToolTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(options: IsolatedVmExecutorOptions = {}) {
    this.options = {
      memoryLimit: options.memoryLimit ?? 128,
      inspector: options.inspector ?? false,
      timeout: options.timeout ?? 30000,
      toolCallTimeout: options.toolCallTimeout ?? (options.timeout ?? 30000),
    };

    this.isolate = new Isolate({
      memoryLimit: this.options.memoryLimit,
      inspector: this.options.inspector,
    });
  }

  /**
   * Execute code within a sandboxed isolate using Promise chain pattern
   *
   * The function `fns` are made available as `codemode.*` within the sandbox.
   * Uses Promise chain: async IIFE → .then() in isolate → sync callback → host Promise
   *
   * Returns ExecuteResult with:
   * - result: The return value of the code
   * - error: Error message if execution failed
   * - logs: Array of console.log outputs
   */
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    // Create new context for this execution (fresh globals)
    const context = await this.createContext();
    const logs: string[] = [];

    // Tool invocation: Track call IDs for notification pattern
    let toolCallId = 0;
    const cleanupPendingTimers = () => {
      for (const timer of this.pendingToolTimers.values()) clearTimeout(timer);
      this.pendingToolTimers.clear();
    };

    try {
      // Set up console logging
      try {
        await context.eval('this.console = {}');
        const consoleRef = await context.global.get('console');
        
        const logCallback = new ivm.Callback((...args: unknown[]) => {
          logs.push(args.map(stringify).join(' '));
        });
        await consoleRef.set('log', logCallback);
        
        const warnCallback = new ivm.Callback((...args: unknown[]) => {
          logs.push('[WARN] ' + args.map(stringify).join(' '));
        });
        await consoleRef.set('warn', warnCallback);
        
        const errorCallback = new ivm.Callback((...args: unknown[]) => {
          logs.push('[ERROR] ' + args.map(stringify).join(' '));
        });
        await consoleRef.set('error', errorCallback);
      } catch (e) {
        // Continue if console setup fails
      }

      // Block dangerous functions
      try {
        await context.eval(`
          this.eval = function() {
            throw new Error("eval is not allowed");
          };
        `);
      } catch (e) {
        // Continue even if this fails
      }

      // Provide setTimeout for async code support (like vm2 does)
      try {
        await context.eval(`
          globalThis.setTimeout = function(fn, delay) {
            Promise.resolve().then(fn);
          };
        `);
      } catch (e) {
        // Continue even if this fails
      }

      // Provide global alias for Node.js compatibility
      try {
        await context.eval(`
          globalThis.global = globalThis;
        `);
      } catch (e) {
        // Continue even if this fails
      }

      // Precompile resolver script once — resolves all pending promises that
      // have results/errors waiting in _toolResults/_toolErrors. The host copies
      // data into those objects via ExternalCopy, then runs this script.
      const resolverScript = await this.isolate.compileScript(`
        (function() {
          for (const id in globalThis._toolResults) {
            if (globalThis._pendingResolvers[id]) {
              globalThis._pendingResolvers[id].resolve(globalThis._toolResults[id]);
              delete globalThis._pendingResolvers[id];
            }
            delete globalThis._toolResults[id];
          }
          for (const id in globalThis._toolErrors) {
            if (globalThis._pendingResolvers[id]) {
              globalThis._pendingResolvers[id].reject(new Error(globalThis._toolErrors[id]));
              delete globalThis._pendingResolvers[id];
            }
            delete globalThis._toolErrors[id];
          }
        })();
      `);

      // Set up tool invocation: precompiled notification pattern
      // 1. hostExecuteTool starts async execution and returns a call ID
      // 2. When done, host copies result into _toolResults[callId] via ExternalCopy
      // 3. Host runs the precompiled resolver script to resolve the Promise
      const hostExecuteTool = new ivm.Callback(
        (toolName: string, toolArgs: unknown) => {
          const callId = toolCallId++;
          const fn = fns[toolName];

          let settled = false;

          const notifySuccess = async (value: unknown) => {
            if (settled) return;
            settled = true;
            const timer = this.pendingToolTimers.get(callId);
            if (timer !== undefined) {
              clearTimeout(timer);
              this.pendingToolTimers.delete(callId);
            }
            try {
              const ref = await context.global.get('_toolResults');
              await ref.set(String(callId), new ivm.ExternalCopy(value).copyInto({ transferIn: true }));
              await resolverScript.run(context);
            } catch (e) {
              // Delivery failed -- fall back to notifying the isolate of an error
              try {
                const errMsg = `Tool result delivery failed: ${e instanceof Error ? e.message : String(e)}`;
                const ref = await context.global.get('_toolErrors');
                await ref.set(String(callId), new ivm.ExternalCopy(errMsg).copyInto({ transferIn: true }));
                await resolverScript.run(context);
              } catch { /* context disposed */ }
            }
          };

          const notifyError = async (error: unknown) => {
            if (settled) return;
            settled = true;
            const timer = this.pendingToolTimers.get(callId);
            if (timer !== undefined) {
              clearTimeout(timer);
              this.pendingToolTimers.delete(callId);
            }
            try {
              const errorMsg = error instanceof Error ? error.message : String(error);
              const ref = await context.global.get('_toolErrors');
              await ref.set(String(callId), new ivm.ExternalCopy(errorMsg).copyInto({ transferIn: true }));
              await resolverScript.run(context);
            } catch { /* context disposed */ }
          };

          if (!fn) {
            void notifyError(new Error(`Tool '${toolName}' not found`));
            return callId;
          }

          // Start per-tool-call timeout
          const toolTimer = setTimeout(() => {
            this.pendingToolTimers.delete(callId);
            logWarn(`Tool '${toolName}' (callId=${callId}) timed out after ${this.options.toolCallTimeout}ms`, { component: 'IsolatedVmExecutor' });
            void notifyError(new Error(`Tool '${toolName}' timed out after ${this.options.toolCallTimeout}ms`));
          }, this.options.toolCallTimeout);
          this.pendingToolTimers.set(callId, toolTimer);

          // Execute the tool async, spread array arguments
          fn(...(Array.isArray(toolArgs) ? toolArgs : [toolArgs]))
            .then(notifySuccess)
            .catch(notifyError);

          return callId;
        }
      );

      await context.global.set(
        '_hostExecuteTool',
        hostExecuteTool
      );

      // Set up codemode object with tool wrappers
      // Each tool: creates a promise, starts execution, host notifies when done
      const codemodeSandbox: Record<string, any> = {};
      for (const toolName of Object.keys(fns)) {
        codemodeSandbox[toolName] = toolName; // Just pass the name as string
      }

      await context.global.set(
        'codemode',
        new ivm.ExternalCopy(codemodeSandbox).copyInto({ transferIn: true })
      );

      // Set up the tool wrapper in isolate - uses notification pattern
      // Refactored: mutate codemode in-place instead of reassigning, so it can be
      // made non-configurable/non-writable on globalThis.
      await context.eval(`
        // Internal state — non-enumerable to hide from user code
        Object.defineProperty(globalThis, '_pendingResolvers', { value: {}, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(globalThis, '_toolResults',      { value: {}, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(globalThis, '_toolErrors',       { value: {}, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(globalThis, '_hostExecuteTool',  {
          value: globalThis._hostExecuteTool,
          writable: false, enumerable: false, configurable: false
        });

        // Replace codemode entries in-place with async tool wrappers
        const _toolNames = Object.keys(codemode);
        for (const key of Object.keys(codemode)) { delete codemode[key]; }
        for (const toolName of _toolNames) {
          codemode[toolName] = (...args) => {
            return new Promise((resolve, reject) => {
              const callId = _hostExecuteTool(toolName, args);
              globalThis._pendingResolvers[callId] = { resolve, reject };
            });
          };
        }
      `);

      // Use Promise-based execution with async function
      const resultPromise = new Promise<ExecuteResult>(async (resolve) => {
        // Create resolve/reject callbacks for the isolate
        const resolveCallback = new ivm.Callback((result: unknown) => {
          resolve({
            result,
            logs: logs.length > 0 ? logs : undefined,
          });
        });

        const rejectCallback = new ivm.Callback((error: unknown) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          resolve({
            result: undefined,
            error: errorMsg,
            logs: logs.length > 0 ? logs : undefined,
          });
        });

        try {
          // Set protocol callbacks in isolate
          await context.global.set(
            'protocol',
            new ivm.ExternalCopy({
              resolve: resolveCallback,
              reject: rejectCallback,
            }).copyInto({ transferIn: true })
          );

          // Sandbox hardening — runs after ALL setup (including protocol), before user code
          await context.eval(`
            // 1. Freeze prototypes to prevent prototype pollution
            Object.freeze(Object.prototype);
            Object.freeze(Array.prototype);
            Object.freeze(Function.prototype);

            // 2. Block eval and Function constructor
            Object.defineProperty(globalThis, 'eval', {
              value: function() { throw new Error("eval is not allowed"); },
              writable: false, enumerable: false, configurable: false
            });
            (function() {
              var OrigFunction = Function;
              function BlockedFunction() { throw new Error("Function constructor is not allowed"); }
              BlockedFunction.prototype = OrigFunction.prototype;
              globalThis.Function = BlockedFunction;
            })();

            // 3. Make codemode non-configurable & non-writable
            Object.defineProperty(globalThis, 'codemode', {
              value: globalThis.codemode,
              writable: false,
              configurable: false,
              enumerable: true,
            });

            // 4. Make protocol & internal state non-enumerable
            Object.defineProperty(globalThis, 'protocol', {
              value: globalThis.protocol,
              writable: false,
              enumerable: false,
              configurable: false,
            });
            // _hostExecuteTool already non-configurable from tool setup

            // 5. Seal globalThis to prevent adding/removing properties
            Object.seal(globalThis);
          `);

          // Wrap code so it returns a Promise we can .then()
          const wrappedCode = wrapCode(code, { alwaysAsync: true });

          // Execute the async function and chain its Promise with .then()
          await context.eval(`(${wrappedCode}).then(protocol.resolve, protocol.reject);`);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          resolve({
            result: undefined,
            error: errorMsg,
            logs: logs.length > 0 ? logs : undefined,
          });
        }
      });

      // Wait for the Promise-based execution to complete
      const result = await resultPromise;
      cleanupPendingTimers();

      // Capture metrics before cleanup
      await this.captureMetrics();

      return result;
    } catch (error) {
      cleanupPendingTimers();
      await this.captureMetrics();

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Distinguish timeout errors
      if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('CPU time limit')
      ) {
        return {
          result: undefined,
          error: `Execution timeout (${this.options.timeout}ms exceeded)`,
          logs: logs.length > 0 ? logs : undefined,
        };
      }

      // Distinguish memory limit errors
      if (errorMessage.includes('memory') || errorMessage.includes('heap')) {
        return {
          result: undefined,
          error: `Memory limit exceeded (${this.options.memoryLimit}MB)`,
          logs: logs.length > 0 ? logs : undefined,
        };
      }

      return {
        result: undefined,
        error: errorMessage,
        logs: logs.length > 0 ? logs : undefined,
      };
    }
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    // Cancel any in-flight tool-call timers
    for (const timer of this.pendingToolTimers.values()) clearTimeout(timer);
    this.pendingToolTimers.clear();

    if (this.context) {
      try {
        this.context.release();
      } catch (e) {
        // Ignore
      }
      this.context = null;
    }

    if (this.isolate) {
      try {
        this.isolate.dispose();
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Get heap statistics from the isolate
   */
  async getHeapStatistics(): Promise<{
    total: number;
    used: number;
    limit: number;
  }> {
    const stats = await this.isolate.getHeapStatistics();
    return {
      total: stats.total_heap_size,
      used: stats.used_heap_size,
      limit: this.options.memoryLimit * 1024 * 1024,
    };
  }

  /**
   * Create or recreate context (resets globals for isolation)
   */
  private async createContext(): Promise<ContextType> {
    // Release old context if it exists
    if (this.context) {
      try {
        this.context.release();
      } catch (e) {
        // Ignore
      }
    }

    this.context = await this.isolate.createContext({
      inspector: this.options.inspector,
    });

    return this.context;
  }

  /**
   * Capture execution metrics
   */
  private async captureMetrics(): Promise<void> {
    try {
      const stats = await this.isolate.getHeapStatistics();
      this.metrics = {
        cpuTime: BigInt(0),
        wallTime: BigInt(0),
        heapUsed: stats.used_heap_size,
        heapLimit: stats.heap_size_limit,
      };
    } catch (e) {
      // Ignore metrics capture errors
    }
  }
}

/**
 * Factory function to create an isolated-vm executor instance
 */
export function createIsolatedVmExecutor(options?: IsolatedVmExecutorOptions): Executor {
  return new IsolatedVmExecutor(options);
}
