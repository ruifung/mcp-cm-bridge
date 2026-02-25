/**
 * Executor factory and registry for Codemode SDK
 * Selects the best available executor (isolated-vm → container → vm2)
 */

import { execFileSync } from "node:child_process";
import type { Executor } from "@cloudflare/codemode";
import { logInfo } from "../utils/logger.js";

// ── Executor type ───────────────────────────────────────────────────

export type ExecutorType = 'isolated-vm' | 'container' | 'vm2';

/**
 * Metadata about the executor that was created.
 */
export interface ExecutorInfo {
  /** The executor type that was selected */
  type: ExecutorType;
  /** How the executor was selected */
  reason: 'explicit' | 'auto-detected';
  /** Execution timeout in ms */
  timeout: number;
}

// ── Registry entry ──────────────────────────────────────────────────

interface ExecutorEntry {
  /** Executor type name */
  type: ExecutorType;
  /** Lower = preferred. Entries are tried in ascending order. */
  preference: number;
  /** Returns true if this executor can be used in the current environment. */
  isAvailable: () => Promise<boolean>;
  /** Creates the executor instance. Only called after isAvailable() returns true. */
  create: (timeout: number) => Promise<Executor>;
}

// ── Availability checks (cached) ────────────────────────────────────

let _isolatedVmAvailable: boolean | null = null;

async function isIsolatedVmAvailable(): Promise<boolean> {
  if (_isolatedVmAvailable !== null) return _isolatedVmAvailable;
  try {
    // @ts-ignore - isolated-vm is an optional dependency
    const ivm = await import('isolated-vm');
    
    // Thorough check: try to create a small isolate to ensure 
    // the native module is actually functional and not just present but broken.
    const isolate = new ivm.default.Isolate({ memoryLimit: 8 });
    isolate.dispose();
    
    _isolatedVmAvailable = true;
  } catch (err) {
    // Silently fail, just means this executor isn't an option
    _isolatedVmAvailable = false;
  }
  return _isolatedVmAvailable;
}

let _containerRuntimeAvailable: boolean | null = null;

async function isContainerRuntimeAvailable(): Promise<boolean> {
  if (_containerRuntimeAvailable !== null) return _containerRuntimeAvailable;
  
  // Check for docker or podman
  for (const cmd of ['docker', 'podman']) {
    try {
      // Use 'ps' instead of '--version' because 'ps' requires the 
      // runtime daemon/service to be actually running and responsive.
      // execFileSync is okay here as it's a one-time check during startup/first-use.
      execFileSync(cmd, ['ps'], { stdio: 'ignore', timeout: 3000 });
      _containerRuntimeAvailable = true;
      return true;
    } catch {
      // not available or not running
    }
  }
  
  _containerRuntimeAvailable = false;
  return false;
}

// ── Executor registry (sorted by preference, lowest first) ─────────

const executorRegistry: ExecutorEntry[] = [
  {
    type: 'isolated-vm',
    preference: 0,
    isAvailable: isIsolatedVmAvailable,
    async create(timeout) {
      const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
      return createIsolatedVmExecutor({ timeout });
    },
  },
  {
    type: 'container',
    preference: 1,
    isAvailable: isContainerRuntimeAvailable,
    async create(timeout) {
      const { createContainerExecutor } = await import('../executor/container-executor.js');
      return createContainerExecutor({ timeout });
    },
  },
  {
    type: 'vm2',
    preference: 2,
    isAvailable: async () => {
      try {
        await import('vm2');
        return true;
      } catch {
        return false;
      }
    },
    async create(timeout) {
      const { createVM2Executor } = await import('../executor/vm2-executor.js');
      return createVM2Executor({ timeout });
    },
  },
];

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Factory function to create an Executor instance.
 *
 * Selection logic:
 *   - If explicitType is provided, that executor is used (throws if unavailable).
 *   - If EXECUTOR_TYPE is set, that executor is used (throws if unavailable).
 *   - Otherwise, executors are tried in preference order (isolated-vm →
 *     container → vm2) and the first available one is selected.
 *
 * Returns both the executor and metadata about the selection.
 */
export async function createExecutor(timeout = 30000, explicitType?: ExecutorType): Promise<{ executor: Executor; info: ExecutorInfo }> {
  const requested = (explicitType || process.env.EXECUTOR_TYPE?.toLowerCase()) as ExecutorType | undefined;

  // Explicit selection — must succeed or throw
  if (requested) {
    const entry = executorRegistry.find(e => e.type === requested);
    if (!entry) {
      const known = executorRegistry.map(e => e.type).join(', ');
      throw new Error(
        `Unknown executor type "${requested}". Valid types: ${known}`
      );
    }
    const available = await entry.isAvailable();
    if (!available) {
      throw new Error(
        `Executor type ${requested} requested but it is not available in this environment.`
      );
    }
    logInfo(`Using ${entry.type} executor (${explicitType ? 'explicit option' : `EXECUTOR_TYPE=${requested}`})`, { component: 'Executor' });
    return {
      executor: await entry.create(timeout),
      info: { type: entry.type, reason: 'explicit', timeout },
    };
  }

  // Auto-detect — walk registry in preference order
  const sorted = [...executorRegistry].sort((a, b) => a.preference - b.preference);
  for (const entry of sorted) {
    const available = await entry.isAvailable();
    if (available) {
      logInfo(`Using ${entry.type} executor (auto-detected)`, { component: 'Executor' });
      return {
        executor: await entry.create(timeout),
        info: { type: entry.type, reason: 'auto-detected', timeout },
      };
    }
  }

  // Should never happen since vm2 is always available
  throw new Error('No executor implementation available.');
}
