/**
 * E2E Bridge Test Runner
 *
 * Runs the E2E bridge test suite against each executor implementation.
 * This mirrors the pattern used in executor-runner.test.ts.
 */

import { createE2EBridgeTestSuite } from './e2e-bridge-test-suite.js';
import { createVM2Executor } from '../executor/vm2-executor.js';
import { createIsolatedVmExecutor } from '../executor/isolated-vm-executor.js';
import { createContainerExecutor } from '../executor/container-executor.js';
import { createDenoExecutor } from '../executor/deno-executor.js';
import { isNode, isDeno, isBun, getNodeMajorVersion, getRuntimeName } from '../utils/env.js';
import { execSync } from 'node:child_process';
import { initializeLogger } from '../utils/logger.js';

initializeLogger(true);

console.log(`[E2E Runner] Detected Runtime: ${getRuntimeName()}`);

// Run E2E suite against Deno executor
// We prioritize Deno when running on Deno.
let denoAvailable = isDeno();
if (!denoAvailable) {
  try {
    execSync('deno --version', { stdio: 'ignore' });
    denoAvailable = true;
  } catch {
    // Deno not found in PATH
  }
}

if (denoAvailable) {
  createE2EBridgeTestSuite('deno', () => createDenoExecutor(), {
    skipTests: [
      // JSON serialization boundary: undefined becomes null over the wire
      'should return undefined for no return statement',
    ],
    testTimeout: 30000,
  });
}

// Run E2E suite against vm2 executor
if (!isBun()) {
  createE2EBridgeTestSuite('vm2', () => createVM2Executor({ timeout: 10000 }));
}

// Run E2E suite against isolated-vm executor
const nodeMajorVersion = getNodeMajorVersion();
const isEvenNodeVersion = nodeMajorVersion > 0 && nodeMajorVersion % 2 === 0;

if (isNode() && isEvenNodeVersion) {
  try {
    const { createIsolatedVmExecutor } = await import('../executor/isolated-vm-executor.js');
    createE2EBridgeTestSuite('isolated-vm', () =>
      createIsolatedVmExecutor({ memoryLimit: 256, timeout: 10000 }),
    );
  } catch (e) {
    // isolated-vm is a native module that might fail to load even if the version check passes
    // (e.g. when running in Deno's Node compatibility layer)
  }
}

// Run E2E suite against container executor (Docker/Podman)
// Container provides OS-level isolation (network=none, read-only, cap-drop=ALL)
// rather than JS-level sandboxing, so require/process ARE available inside.
createE2EBridgeTestSuite('container', () => createContainerExecutor(), {
  skipTests: [
    // JS-level isolation — container runs full Node.js
    'should not allow require access',
    'should not allow process access',
  ],
  testTimeout: 30000,
});
