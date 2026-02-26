/**
 * Executor Implementation for Codemode SDK
 * Implements the @cloudflare/codemode Executor interface using vm2 sandbox
 *
 * **DEPRECATED — SECURITY RISK**
 * vm2 is unmaintained and has 6 unfixable CVSS 10.0 sandbox escape CVEs.
 * This executor exists only as a last-resort fallback when neither
 * isolated-vm nor a container runtime is available.
 * It must NEVER be used in production environments.
 */

import { VM } from "vm2";
import type { Executor, ExecuteResult } from "@cloudflare/codemode";
import { wrapCode } from "./wrap-code.js";
import { logWarn } from "../utils/logger.js";
import chalk from "chalk";

// ── Security Warning ────────────────────────────────────────────────

const VM2_WARNING_BANNER = [
  '',
  chalk.bgRed.white.bold('╔══════════════════════════════════════════════════════════════════════════════╗'),
  chalk.bgRed.white.bold('║  ⚠⚠⚠  SECURITY WARNING: VM2 EXECUTOR IS ACTIVE  ⚠⚠⚠                       ║'),
  chalk.bgRed.white.bold('╠══════════════════════════════════════════════════════════════════════════════╣'),
  chalk.bgRed.white.bold('║                                                                            ║'),
  chalk.bgRed.white.bold('║  vm2 is DEPRECATED and has 6 unfixable sandbox escape vulnerabilities       ║'),
  chalk.bgRed.white.bold('║  rated CVSS 10.0 (CRITICAL). Arbitrary host code execution is possible.     ║'),
  chalk.bgRed.white.bold('║                                                                            ║'),
  chalk.bgRed.white.bold('║  CVEs: CVE-2023-37466, CVE-2023-37903, CVE-2023-32314,                     ║'),
  chalk.bgRed.white.bold('║        CVE-2023-32313, CVE-2023-29199, CVE-2023-29017                      ║'),
  chalk.bgRed.white.bold('║                                                                            ║'),
  chalk.bgRed.white.bold('║  DO NOT USE IN PRODUCTION. The sandbox provides NO real security.           ║'),
  chalk.bgRed.white.bold('║  Use isolated-vm or container executors instead.                            ║'),
  chalk.bgRed.white.bold('║                                                                            ║'),
  chalk.bgRed.white.bold('╚══════════════════════════════════════════════════════════════════════════════╝'),
  '',
].join('\n');

let _vm2WarningShown = false;

function emitVM2SecurityWarning(): void {
  if (_vm2WarningShown) return;
  _vm2WarningShown = true;
  logWarn(VM2_WARNING_BANNER, { component: 'VM2Executor' });
}

// ── VM2Executor ─────────────────────────────────────────────────────

/**
 * VM2-based Executor implementation
 *
 * **DEPRECATED**: vm2 has multiple unfixable CVSS 10.0 sandbox escape
 * vulnerabilities. This executor exists only as a last-resort fallback
 * when neither isolated-vm nor a container runtime is available.
 * It should NEVER be used in production environments.
 */
export class VM2Executor implements Executor {
  private timeout: number;

  constructor(timeout = 30000) {
    this.timeout = timeout;
    emitVM2SecurityWarning();
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
      // Wrap code using shared wrapCode utility (handles arrow functions, statements, etc.)
      const wrappedCode = wrapCode(code);

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

      // Sandbox hardening — runs before user code
      vm.run(`
        // 1. Freeze prototypes to prevent prototype pollution
        Object.freeze(Object.prototype);
        Object.freeze(Array.prototype);
        Object.freeze(Function.prototype);

        // 2. Block Function constructor (equivalent to eval)
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
      `, "codemode-hardening.js");

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
 * Factory function to create a VM2 executor instance.
 *
 * **DEPRECATED**: vm2 has unfixable CVSS 10.0 sandbox escape CVEs.
 * Prefer isolated-vm or container executors.
 */
export function createVM2Executor(options?: { timeout?: number }): Executor {
  return new VM2Executor(options?.timeout);
}
