/**
 * Executor Implementation for Codemode SDK
 * Implements the @cloudflare/codemode Executor interface using vm2 sandbox
 */

import { VM } from "vm2";
import type { Executor, ExecuteResult } from "@cloudflare/codemode";

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
      const wrappedCode = this.wrapCode(code);

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
   * Wraps code in an async IIFE if it's not already wrapped
   * This ensures the LLM-generated code can use await
   */
  private wrapCode(code: string): string {
    const trimmed = code.trim();

    // If it's already an async function or async arrow function, wrap in IIFE
    if (
      trimmed.startsWith("async") ||
      trimmed.startsWith("async function")
    ) {
      return `(${trimmed})()`;
    }

    // If it's an arrow function (async or not), wrap in IIFE
    // Match actual arrow function syntax: (params) => or param => or async (params) => or async param =>
    if (/^\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/.test(trimmed)) {
      return `(${trimmed})()`;
    }

    // Otherwise, assume it's a block of statements - wrap in async IIFE
    return `(async () => { ${trimmed} })()`;
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
 * Factory function to create an Executor instance.
 *
 * Selection logic:
 *   1. EXECUTOR_TYPE=vm2         → always use vm2
 *   2. EXECUTOR_TYPE=isolated-vm → always use isolated-vm (throws if unavailable)
 *   3. EXECUTOR_TYPE unset       → prefer isolated-vm, fall back to vm2
 */
export async function createExecutor(timeout = 30000): Promise<Executor> {
  const requested = process.env.EXECUTOR_TYPE?.toLowerCase();

  if (requested === 'vm2') {
    return new VM2Executor(timeout);
  }

  if (requested === 'isolated-vm') {
    const available = await isIsolatedVmAvailable();
    if (!available) {
      throw new Error(
        'EXECUTOR_TYPE=isolated-vm but the "isolated-vm" package is not installed. ' +
        'Install it with: npm install isolated-vm'
      );
    }
    const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
    return createIsolatedVmExecutor({ timeout });
  }

  // Default: prefer isolated-vm, fall back to vm2
  const available = await isIsolatedVmAvailable();
  if (available) {
    const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
    return createIsolatedVmExecutor({ timeout });
  }

  return new VM2Executor(timeout);
}
