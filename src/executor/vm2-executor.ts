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
      // Wrap code in async IIFE and await the result
      const wrappedCode = `
(async () => {
${code.split('\n').map(line => '  ' + line).join('\n')}
})()
`;

      const vm = new VM({
        timeout: this.timeout,
        eval: false,
        sandbox: {
          console: capturedConsole,
          codemode: fns,
          // Block eval for security
          eval: () => { throw new Error('eval is not allowed'); },
          setTimeout: (fn: () => void, delay: number) => {
            return new Promise<void>((resolve) => {
              setTimeout(() => { fn(); resolve(); }, delay ?? 0);
            });
          },
          setInterval: (fn: () => void, delay: number) => {
            return setInterval(fn, delay ?? 0);
          },
          clearInterval: (id: ReturnType<typeof setInterval>) => {
            clearInterval(id);
          },
          clearTimeout: (id: ReturnType<typeof setTimeout>) => {
            clearTimeout(id);
          },
        },
      });

      // vm.run() returns a Promise if the code returns a Promise
      const rawResult = vm.run(wrappedCode, "codemode-execution.js");
      
      // Await the result if it's a promise
      const result = rawResult instanceof Promise ? await rawResult : rawResult;

      return {
        result,
        ...(logs.length > 0 && { logs }),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        result: undefined,
        error: errorMessage,
        ...(logs.length > 0 && { logs }),
      };
    }
  }

  private stringify(value: unknown): string {
    try {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean")
        return String(value);
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "object") {
        if (value instanceof Error) {
          return `Error: ${value.message}`;
        }
        if (Array.isArray(value)) {
          return `[ ${value.map((v) => this.stringify(v)).join(", ")} ]`;
        }
        // For objects, use JSON.stringify with a replacer to handle circular refs
        return JSON.stringify(value, (key, val) => {
          if (typeof val === "function") return "[Function]";
          return val;
        });
      }
      return String(value);
    } catch {
      return "[Object]";
    }
  }
}

/**
 * Factory function to create a VM2 executor instance
 */
export function createVM2Executor(options?: { timeout?: number }): Executor {
  return new VM2Executor(options?.timeout);
}
