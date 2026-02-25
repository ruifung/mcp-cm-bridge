import { execFileSync } from "node:child_process";
import { isNode, isDeno, isBun, getNodeMajorVersion } from "../utils/env.js";
import { logDebug } from "../utils/logger.js";

// Keep this in sync with executorRegistry in src/mcp/executor.ts
export type ExecutorType = 'isolated-vm' | 'container' | 'deno' | 'vm2';

async function isDenoAvailable(): Promise<boolean> {
  return isDeno();
}

async function isIsolatedVmAvailable(): Promise<boolean> {
  const majorVersion = getNodeMajorVersion();
  const isEvenVersion = majorVersion > 0 && majorVersion % 2 === 0;

  if (!isNode() || !isEvenVersion) {
    return false;
  }

  try {
    const checkScript = `
      import ivm from 'isolated-vm';
      const isolate = new ivm.Isolate({ memoryLimit: 8 });
      isolate.dispose();
      process.exit(0);
    `;
    
    const { execSync } = await import('node:child_process');
    execSync(`node -e "${checkScript.replace(/"/g, '\\"').replace(/\n/g, '')}"`, { stdio: 'ignore', timeout: 2000 });
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
