import { execFileSync } from "node:child_process";
import { isNode, isDeno, isBun, getNodeMajorVersion } from "../utils/env.js";
import { logDebug } from "../utils/logger.js";

// Resolve isolated-vm's entry point via ESM module resolution (honours the actual
// package manager layout — works with npm, pnpm, Yarn PnP, monorepos, etc.).
// import.meta.resolve() resolves relative to this file, not the process cwd,
// so it is correct regardless of where the bridge process is launched from.
const _ivmFileUrl = import.meta.resolve('isolated-vm');

// Keep this in sync with executorRegistry in src/mcp/executor.ts
export type ExecutorType = 'isolated-vm' | 'container' | 'deno' | 'vm2';

async function isDenoAvailable(): Promise<boolean> {
  // If the current process is already Deno, it is obviously available.
  if (isDeno()) return true;

  // Otherwise probe PATH for an installed deno binary.
  // execFileSync uses PATH-based lookup — cwd does not affect PATH resolution,
  // so this is correct regardless of where the bridge process was launched from.
  try {
    execFileSync('deno', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function isIsolatedVmAvailable(): Promise<boolean> {
  const majorVersion = getNodeMajorVersion();
  const isEvenVersion = majorVersion > 0 && majorVersion % 2 === 0;

  if (!isNode() || !isEvenVersion) {
    return false;
  }

  try {
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
    return true;
  } catch (err) {
    return false;
  }
}

async function isContainerRuntimeAvailable(): Promise<boolean> {
  for (const cmd of ['docker', 'podman']) {
    try {
      execFileSync(cmd, ['ps'], { stdio: 'ignore', timeout: 2000 });
      return true;
    } catch (err) {
      // not available
    }
  }
  return false;
}

async function isVM2Available(): Promise<boolean> {
  if (isBun()) return false;
  try {
    await import('vm2');
    return true;
  } catch {
    return false;
  }
}

export interface ExecutorStatus {
  type: ExecutorType;
  isAvailable: boolean;
}

export async function getExecutorStatus(): Promise<ExecutorStatus[]> {
  const statuses: ExecutorStatus[] = [
    { type: 'deno', isAvailable: await isDenoAvailable() },
    { type: 'isolated-vm', isAvailable: await isIsolatedVmAvailable() },
    { type: 'container', isAvailable: await isContainerRuntimeAvailable() },
    { type: 'vm2', isAvailable: await isVM2Available() },
  ];
  return statuses;
}
