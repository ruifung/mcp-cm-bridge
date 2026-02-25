/**
 * Shared code-wrapping utility for executor implementations.
 *
 * The SDK's normalizeCode() shapes LLM-generated code into a callable
 * function expression (arrow function). The executor's job is to invoke
 * it — `(code)()`. When the executor is called directly (without
 * normalizeCode()), it must also handle raw statements.
 *
 * This module uses acorn AST parsing to reliably classify code shape,
 * matching how the SDK's normalizeCode() detects arrow functions.
 */

import * as acorn from 'acorn';

/**
 * The shape of the code as determined by AST parsing.
 *
 * - `async-function`    — `async function ...` or `async () => ...`
 * - `sync-arrow`        — `(params) => ...` or `param => ...` (non-async)
 * - `sync-function`     — `function ...` (non-async named/anonymous function)
 * - `raw-statements`    — anything else (variable declarations, calls, etc.)
 */
export type CodeShape =
  | 'async-function'
  | 'sync-arrow'
  | 'sync-function'
  | 'raw-statements';

/**
 * Classify the shape of a code string using acorn AST parsing.
 *
 * Falls back to `'raw-statements'` if the code cannot be parsed
 * (which will cause it to be wrapped in an async IIFE).
 */
export function classifyCode(code: string): CodeShape {
  const trimmed = code.trim();
  if (!trimmed) return 'raw-statements';

  try {
    const ast = acorn.parse(trimmed, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });

    // Single expression statement — check what kind of function it is
    if (ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement') {
      const expr = (ast.body[0] as acorn.ExpressionStatement).expression;

      if (expr.type === 'ArrowFunctionExpression') {
        return expr.async ? 'async-function' : 'sync-arrow';
      }

      if (expr.type === 'FunctionExpression') {
        return expr.async ? 'async-function' : 'sync-function';
      }
    }

    // Top-level function declaration (not an expression)
    if (ast.body.length === 1 && ast.body[0].type === 'FunctionDeclaration') {
      const decl = ast.body[0] as acorn.FunctionDeclaration;
      return decl.async ? 'async-function' : 'sync-function';
    }

    return 'raw-statements';
  } catch {
    // Parse failed — treat as raw statements
    return 'raw-statements';
  }
}

export interface WrapCodeOptions {
  /**
   * When true, sync arrow functions and sync function expressions are
   * additionally wrapped to ensure the result is always a Promise.
   *
   * Use this when the executor chains the result with `.then()` and
   * cannot handle non-Promise return values (e.g. isolated-vm).
   *
   * When false, sync functions are simply invoked as `(code)()`, and
   * the caller is responsible for handling non-Promise returns
   * (e.g. VM2 checks `'then' in result`).
   *
   * @default false
   */
  alwaysAsync?: boolean;
}

/**
 * Wrap code so it can be executed by an executor.
 *
 * - Function expressions / arrow functions → invoked with `(code)()`
 * - Raw statements → wrapped in `(async () => { code })()`
 * - When `alwaysAsync` is true, sync functions are additionally wrapped
 *   to ensure the result is a Promise.
 */
export function wrapCode(code: string, options?: WrapCodeOptions): string {
  const trimmed = code.trim();
  if (!trimmed) return '(async () => {})()';

  const shape = classifyCode(trimmed);
  const alwaysAsync = options?.alwaysAsync ?? false;

  switch (shape) {
    case 'async-function':
      // Already async — invoke it, result is a Promise
      return `(${trimmed})()`;

    case 'sync-arrow':
    case 'sync-function':
      if (alwaysAsync) {
        // Wrap in async IIFE to ensure result is a Promise
        return `(async () => (${trimmed})())()`;
      }
      // Just invoke — caller handles sync return
      return `(${trimmed})()`;

    case 'raw-statements':
      // Wrap in async IIFE
      return `(async () => { ${trimmed} })()`;
  }
}
