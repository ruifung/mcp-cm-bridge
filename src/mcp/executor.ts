/**
 * Executor factory and registry for Codemode SDK
 * Selects the best available executor (isolated-vm → container → vm2)
 */

import type { Executor } from '../sandbox/executor/helpers/types.js';
import { logInfo, logDebug } from "../utils/logger.js";
import { isDeno } from "../utils/env.js";
import { resolveDockerSocketPath } from '../utils/docker.js';

// Resolve isolated-vm's entry point via ESM module resolution (honours the actual
// package manager layout — works with npm, pnpm, Yarn PnP, monorepos, etc.).
// import.meta.resolve() resolves relative to this file, not the process cwd,
// so it is correct regardless of where the bridge process is launched from.
const _ivmFileUrl = import.meta.resolve('isolated-vm');

// ── Executor type ───────────────────────────────────────────────────

export const ExecutorTypes = ['isolated-vm', 'container', 'deno', 'vm2'] as const;
export type ExecutorType = typeof ExecutorTypes[number];

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

async function isDenoAvailable(): Promise<boolean> {
  // If already running on Deno, execPath is available directly
  if (isDeno()) return true;

  // Otherwise probe PATH for a deno binary
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('deno', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function isIsolatedVmAvailable(): Promise<boolean> {
  if (_isolatedVmAvailable !== null) return _isolatedVmAvailable;

  logDebug('Checking isolated-vm availability...', { component: 'Executor' });
  
  try {
    // Run the check in a separate process because isolated-vm can cause 
    // segmentation faults if native dependencies or environment are incompatible.
    const checkScript = [
      `import ivm from '${_ivmFileUrl}';`,
      "const isolate = new ivm.Isolate({ memoryLimit: 8 });",
      "isolate.dispose();",
      "process.exit(0);",
    ].join(" ");
    
    const { execSync } = await import('node:child_process');
    execSync(
      `"${process.execPath}" --input-type=module -e "${checkScript.replace(/"/g, '\\"')}"`,
      {
        stdio: 'ignore',
        timeout: 5000,
      }
    );
    
    logDebug('isolated-vm is available and functional (verified via subprocess)', { component: 'Executor' });
    _isolatedVmAvailable = true;
  } catch (err) {
    logDebug(`isolated-vm check failed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
    _isolatedVmAvailable = false;
  }
  return _isolatedVmAvailable;
}

let _containerAvailable: boolean | null = null;

async function isContainerAvailable(): Promise<boolean> {
  if (_containerAvailable !== null) return _containerAvailable;

  logDebug('Checking container executor availability...', { component: 'Executor' });
  
  // 1. Check socket availability (Dockerode)
  try {
    const Docker = (await import('dockerode')).default;
    const socketPath = resolveDockerSocketPath();
    logDebug(`Attempting to connect to Docker/Podman socket: ${socketPath || 'default'}`, { component: 'Executor' });
    const docker = new Docker(socketPath ? { socketPath } : {});
    await docker.ping();
    logDebug('Container executor (Docker/Podman socket) is responsive', { component: 'Executor' });
    _containerAvailable = true;
    return true;
  } catch (err) {
    logDebug(`Container executor socket check failed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
  }

  // 2. Fallback to CLI availability check
  try {
    const { execFileSync } = await import('node:child_process');
    for (const cmd of ['docker', 'podman']) {
      try {
        execFileSync(cmd, ['ps'], { stdio: 'ignore', timeout: 3000 });
        logDebug(`Container runtime "${cmd}" CLI is available and responsive`, { component: 'Executor' });
        _containerAvailable = true;
        return true;
      } catch {
        // next cmd
      }
    }
  } catch (err) {
    logDebug(`Container CLI check failed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
  }

  logDebug('No responsive container runtime (socket or CLI) found', { component: 'Executor' });
  _containerAvailable = false;
  return false;
}

// ── Executor registry (sorted by preference, lowest first) ─────────

const executorRegistry: ExecutorEntry[] = [
  {
    type: 'isolated-vm',
    preference: 0,
    isAvailable: isIsolatedVmAvailable,
    async create(timeout) {
      const { createIsolatedVmExecutor } = await import('../sandbox/executor/isolated-vm-executor.js');
      return createIsolatedVmExecutor({ timeout });
    },
  },
  {
    type: 'deno',
    preference: 1,
    isAvailable: isDenoAvailable,
    async create(timeout) {
      const { createDenoExecutor } = await import('../sandbox/executor/deno-executor.js');
      return createDenoExecutor({ timeout });
    },
  },
  {
    type: 'container',
    preference: 2,
    isAvailable: isContainerAvailable,
    async create(timeout) {
      const { createContainerExecutor } = await import('../sandbox/executor/container/container-executor.js');
      return createContainerExecutor({ timeout });
    },
  },
  {
    type: 'vm2',
    preference: 3,
    isAvailable: async () => {
      try {
        const { VM } = await import('vm2');
        const vm = new VM({ timeout: 1000, eval: false });
        const result = vm.run('1 + 1');
        return result === 2;
      } catch {
        return false;
      }
    },
    async create(timeout) {
      const { createVM2Executor } = await import('../sandbox/executor/vm2-executor.js');
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
