/**
 * E2E Bridge Test Runner
 *
 * Runs the E2E bridge test suite against each executor implementation.
 * This mirrors the pattern used in executor-runner.test.ts.
 */

import { createE2EBridgeTestSuite } from './e2e-bridge-test-suite.js';
import { VM2Executor } from './executor.js';
import { createIsolatedVmExecutor } from '../executor/isolated-vm-executor.js';

// Run E2E suite against vm2 executor (bridge version from src/mcp/executor.ts)
createE2EBridgeTestSuite('vm2', () => new VM2Executor(10000));

// Run E2E suite against isolated-vm executor
createE2EBridgeTestSuite('isolated-vm', () =>
  createIsolatedVmExecutor({ memoryLimit: 256, timeout: 10000 }),
);
