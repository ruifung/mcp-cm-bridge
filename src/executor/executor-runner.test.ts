import { describe } from 'vitest';
import { createExecutorTestSuite } from './executor-test-suite.js';
import { createVM2Executor } from './vm2-executor.js';
import { createIsolatedVmExecutor } from './isolated-vm-executor.js';
import { createContainerExecutor } from './container-executor.js';

// Run test suite against vm2
createExecutorTestSuite('vm2', () => createVM2Executor());

// Run test suite against isolated-vm
createExecutorTestSuite('isolated-vm', () =>
  createIsolatedVmExecutor({ memoryLimit: 256 })
);

// Run test suite against container executor (Docker/Podman)
// Security isolation comes from the container boundary (network=none, read-only,
// cap-drop=ALL), not JS-level sandboxing — so require/process/eval ARE available
// inside the container. Performance and concurrency tests are also skipped because
// the container spawns a new worker thread per execute() call.
createExecutorTestSuite('container', () => createContainerExecutor(), {
  skipTests: [
    // JS-level isolation tests — container runs full Node.js inside
    'should not allow access to require',
    'should not allow process access',
    'should not allow eval',
    'should not allow constructor to escape',
    // JSON serialization boundary: undefined becomes null over the wire
    'should return undefined for no return statement',
    'should isolate prototype pollution to the current execution',
    // Performance tests — worker thread per call is slower than in-process
    'should execute simple code quickly',
    'should handle multiple sequential executions',
    // Concurrency tests — container executor serializes executions
    'should handle multiple concurrent executions',
    'should isolate data between concurrent executions',
  ],
  testTimeout: 30000,
});
