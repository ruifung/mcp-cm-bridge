/**
 * Executor Implementation for Codemode SDK
 * Implements the @cloudflare/codemode Executor interface using vm2 sandbox
 */

import { VM } from "vm2";
import type { Executor, ExecuteResult } from "@cloudflare/codemode";
import { logInfo, logWarn } from "../utils/logger.js";
import { wrapCode } from "../executor/wrap-code.js";

/**
 * VM2-based Executor implementation
 * Runs LLM-generated code in an isolated sandbox with access to tools via codemode.* namespace
 */
export class VM2Executor implements Executor {
  private timeout: number;

  constructor(timeout = 30000) {
    this.timeout = timeout;
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const logs: string[] = [];
    const capturedConsole = {
      log: (...args: unknown[]) => {
        logs.push(
          args.map((arg) => this.stringify(arg)).join(" ")
        );
      },
      warn: (...args: unknown[]) => {
        logs.push(
          "[WARN] " + args.map((arg) => this.stringify(arg)).join(" ")
        );
      },
      error: (...args: unknown[]) => {
        logs.push(
          "[ERROR] " + args.map((arg) => this.stringify(arg)).join(" ")
        );
      },
    };

    try {
      // Create a proxy object that intercepts codemode.* calls
      // and routes them to the provided functions
      const codemodeProxy = new Proxy(
        {},
        {
          get: (_target, prop: string | symbol) => {
            const fnName = String(prop);
            if (fnName in fns) {
              return fns[fnName];
            }
            throw new Error(
              `Tool '${fnName}' not found. Available tools: ${Object.keys(fns).join(", ")}`
            );
          },
        }
      );

      // Prepare the code to run - wrap in async IIFE if not already wrapped
      const wrappedCode = wrapCode(code);

      // Create VM with sandbox containing console and codemode
      const vm = new VM({
        timeout: this.timeout,
        sandbox: {
          console: capturedConsole,
          codemode: codemodeProxy,
        },
      });

      // Execute the code and capture result
      const result = vm.run(wrappedCode);

      // If result is a promise, await it with timeout
      if (result && typeof result === "object" && "then" in result) {
        let timeoutHandle: NodeJS.Timeout;
        const awaitedResult = await Promise.race([
          result.finally(() => clearTimeout(timeoutHandle)),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(
                  new Error(
                    `Code execution timeout after ${this.timeout}ms`
                  )
                ),
              this.timeout
            );
          }),
        ]);
        return {
          result: awaitedResult,
          logs: logs.length > 0 ? logs : undefined,
        };
      }

      return {
        result,
        logs: logs.length > 0 ? logs : undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        result: null,
        error: errorMessage,
        logs: logs.length > 0 ? logs : undefined,
      };
    }
  }

  /**
   * Safely stringify values for logging
   */
  private stringify(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}

/**
 * Check if isolated-vm is available (optional dependency)
 */
let isolatedVmAvailable: boolean | null = null;

async function isIsolatedVmAvailable(): Promise<boolean> {
  if (isolatedVmAvailable !== null) return isolatedVmAvailable;
  try {
    // @ts-ignore - isolated-vm is an optional dependency
    await import('isolated-vm');
    isolatedVmAvailable = true;
  } catch {
    isolatedVmAvailable = false;
  }
  return isolatedVmAvailable;
}

/**
 * Metadata about the executor that was created.
 */
export interface ExecutorInfo {
  /** The executor type: 'vm2' or 'isolated-vm' */
  type: 'vm2' | 'isolated-vm';
  /** How the executor was selected */
  reason: 'explicit' | 'auto-detected' | 'fallback';
  /** Execution timeout in ms */
  timeout: number;
}

/**
 * Factory function to create an Executor instance.
 *
 * Selection logic:
 *   1. EXECUTOR_TYPE=vm2         → always use vm2
 *   2. EXECUTOR_TYPE=isolated-vm → always use isolated-vm (throws if unavailable)
 *   3. EXECUTOR_TYPE unset       → prefer isolated-vm, fall back to vm2
 *
 * Returns both the executor and metadata about the selection.
 */
export async function createExecutor(timeout = 30000): Promise<{ executor: Executor; info: ExecutorInfo }> {
  const requested = process.env.EXECUTOR_TYPE?.toLowerCase();

  if (requested === 'vm2') {
    logInfo('Using vm2 executor (EXECUTOR_TYPE=vm2)', { component: 'Executor' });
    return {
      executor: new VM2Executor(timeout),
      info: { type: 'vm2', reason: 'explicit', timeout },
    };
  }

  if (requested === 'isolated-vm') {
    const available = await isIsolatedVmAvailable();
    if (!available) {
      throw new Error(
        'EXECUTOR_TYPE=isolated-vm but the "isolated-vm" package is not installed. ' +
        'Install it with: npm install isolated-vm'
      );
    }
    logInfo('Using isolated-vm executor (EXECUTOR_TYPE=isolated-vm)', { component: 'Executor' });
    const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
    return {
      executor: createIsolatedVmExecutor({ timeout }),
      info: { type: 'isolated-vm', reason: 'explicit', timeout },
    };
  }

  // Default: prefer isolated-vm, fall back to vm2
  const available = await isIsolatedVmAvailable();
  if (available) {
    logInfo('Using isolated-vm executor (auto-detected)', { component: 'Executor' });
    const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
    return {
      executor: createIsolatedVmExecutor({ timeout }),
      info: { type: 'isolated-vm', reason: 'auto-detected', timeout },
    };
  }

  logWarn('isolated-vm not available, falling back to vm2 executor', { component: 'Executor' });
  return {
    executor: new VM2Executor(timeout),
    info: { type: 'vm2', reason: 'fallback', timeout },
  };
}
