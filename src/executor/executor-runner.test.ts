import { describe } from 'vitest';
import { createExecutorTestSuite } from './executor.test.js';
import { createVM2Executor } from './vm2-executor.js';
import { createIsolatedVmExecutor } from './isolated-vm-executor.js';

// Run test suite against vm2
createExecutorTestSuite('vm2', () => createVM2Executor());

// Run test suite against isolated-vm
createExecutorTestSuite('isolated-vm', () =>
  createIsolatedVmExecutor({ memoryLimit: 256 })
);
