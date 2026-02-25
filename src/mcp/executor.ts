/**
 * Executor factory and registry for Codemode SDK
 * Selects the best available executor (isolated-vm → container → vm2)
 */

import type { Executor } from "@cloudflare/codemode";
import { logInfo, logDebug } from "../utils/logger.js";
import { isNode, isDeno, isBun, getNodeMajorVersion } from "../utils/env.js";
import { resolveDockerSocketPath } from '../utils/docker.js';

// ── Executor type ───────────────────────────────────────────────────
 
export type ExecutorType = 'isolated-vm' | 'container' | 'deno' | 'vm2';

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
  // Only allow Deno executor if running on Deno
  return isDeno();
}

async function isIsolatedVmAvailable(): Promise<boolean> {
  if (_isolatedVmAvailable !== null) return _isolatedVmAvailable;

  // isolated-vm is a native module specifically built for Node.js.
  // While Bun and Deno provide compatibility layers, they often fail or
  // exhibit unstable behavior with native Node modules like isolated-vm.
  // Additionally, isolated-vm only supports LTS (even-numbered) Node.js versions.
  const majorVersion = getNodeMajorVersion();
  const isEvenVersion = majorVersion > 0 && majorVersion % 2 === 0;

  if (!isNode() || !isEvenVersion) {
    logDebug('isolated-vm is only supported on LTS (even-numbered) versions of native Node.js (not Bun, Deno, or odd-numbered Node versions)', { component: 'Executor' });
    _isolatedVmAvailable = false;
    return false;
  }

  logDebug('Checking isolated-vm availability...', { component: 'Executor' });
  
  try {
    // We run the check in a separate process because isolated-vm can cause 
    // segmentation faults if native dependencies or environment are incompatible.
    // Running it here ensures a crash doesn't take down the main bridge process.
    const checkScript = `
      import ivm from 'isolated-vm';
      const isolate = new ivm.Isolate({ memoryLimit: 8 });
      isolate.dispose();
      process.exit(0);
    `;
    
    const { execSync } = await import('node:child_process');
    execSync(`node -e "${checkScript.replace(/"/g, '\\"').replace(/\n/g, '')}"`, { stdio: 'ignore', timeout: 5000 });
    
    logDebug('isolated-vm is available and functional (verified via subprocess)', { component: 'Executor' });
    _isolatedVmAvailable = true;
  } catch (err) {
    logDebug(`isolated-vm check failed or crashed: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
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
    type: 'deno',
    preference: 0,
    isAvailable: isDenoAvailable,
    async create(timeout) {
      const { createDenoExecutor } = await import('../executor/deno-executor.js');
      return createDenoExecutor({ timeout });
    },
  },
  {
    type: 'isolated-vm',
    preference: 1,
    isAvailable: isIsolatedVmAvailable,
    async create(timeout) {
      const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
      return createIsolatedVmExecutor({ timeout });
    },
  },
  {
    type: 'container',
    preference: 2,
    isAvailable: isContainerAvailable,
    async create(timeout) {
      const { createContainerExecutor } = await import('../executor/container-executor.js');
      return createContainerExecutor({ timeout });
    },
  },
  {
    type: 'vm2',
    preference: 3,
    isAvailable: async () => {
      // vm2 is fundamentally broken on Bun (prototype freezing issues)
      // and Node.js built-in 'node:vm' is not safe for untrusted code.
      if (isBun()) return false;
      
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
