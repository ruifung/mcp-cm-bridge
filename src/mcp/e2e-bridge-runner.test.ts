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

// Run E2E suite against vm2 executor
createE2EBridgeTestSuite('vm2', () => createVM2Executor({ timeout: 10000 }));

// Run E2E suite against isolated-vm executor
createE2EBridgeTestSuite('isolated-vm', () =>
  createIsolatedVmExecutor({ memoryLimit: 256, timeout: 10000 }),
);

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
