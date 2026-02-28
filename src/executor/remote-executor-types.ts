/**
 * Shared types for the executor system.
 *
 * These types are used by all executor implementations (deno, container-cli,
 * container-socket) and are extracted here to avoid duplication.
 */

import type { ExecuteResult } from '@cloudflare/codemode';

// ── Host → Runtime messages ─────────────────────────────────────────

/** Messages sent from the host process → the runtime (deno/container). */
export type HostMessage =
  | { type: 'execute'; id: string; code: string }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'tool-error'; id: string; error: string }
  | { type: 'heartbeat' }
  | { type: 'shutdown' };

// ── Runtime → Host messages ─────────────────────────────────────────

/**
 * Messages sent from the runtime (deno/container) → the host process.
 *
 * Unified rename of what was previously called `DenoMessage` in
 * deno-executor and `ContainerMessage` in the container executors.
 * All three are structurally identical.
 */
export type RuntimeMessage =
  | { type: 'ready' }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'result'; id: string; result: unknown; logs?: string[] }
  | { type: 'error'; id: string; error: string; logs?: string[] }
  | { type: 'error'; error: { message: string; stack?: string; name?: string } };

// ── Pending execution ───────────────────────────────────────────────

/**
 * State for an in-flight code execution.
 * Previously defined as an anonymous inline type in all three executor files.
 */
export interface PendingExecution {
  id: string;
  resolve: (result: ExecuteResult) => void;
  reject: (error: Error) => void;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  timeoutHandle: NodeJS.Timeout;
}
