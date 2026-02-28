/**
 * Core executor interfaces.
 *
 * These were originally imported from `@cloudflare/codemode` but are defined
 * here so the package is not a runtime dependency.
 */

/**
 * The result of a sandboxed code execution.
 */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable as `codemode.*` inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 */
export interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}
