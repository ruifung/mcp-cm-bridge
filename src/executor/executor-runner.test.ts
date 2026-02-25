import { createExecutorTestSuite } from './executor-test-suite.js';
import { createVM2Executor } from './vm2-executor.js';
import { createIsolatedVmExecutor } from './isolated-vm-executor.js';
import { createContainerExecutor } from './container-executor.js';
import { createDenoExecutor } from './deno-executor.js';
import { execSync } from 'node:child_process';
import { isNode, isBun, getNodeMajorVersion } from '../utils/env.js';

// Run test suite against vm2
// globalThis sealing doesn't work with vm2's proxy-based sandbox
// Proxy constructor is not available in vm2's sandbox
// We skip vm2 on Bun as it's fundamentally incompatible.
if (!isBun()) {
  createExecutorTestSuite('vm2', () => createVM2Executor(), {
    skipTests: [
      'should prevent adding new globals when globalThis is sealed',
      'should handle Proxy and Reflect',
    ],
  });
}

// Run test suite against isolated-vm
// Concurrent global assignment fails because Object.seal(globalThis)
// prevents adding new properties (each context is sealed after setup).
const nodeMajorVersion = getNodeMajorVersion();
const isEvenNodeVersion = nodeMajorVersion > 0 && nodeMajorVersion % 2 === 0;

if (isNode() && isEvenNodeVersion) {
  try {
    const { createIsolatedVmExecutor } = await import('./isolated-vm-executor.js');
    createExecutorTestSuite('isolated-vm', () =>
      createIsolatedVmExecutor({ memoryLimit: 256 }),
      {
        skipTests: [
          'should isolate data between concurrent executions',
        ],
      }
    );
  } catch (e) {
    // isolated-vm might fail to load in non-native Node environments (e.g. Deno)
  }
}

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
    'should block prototype pollution',
    // Prototype freezing tests — container doesn't freeze prototypes
    'should freeze Array.prototype',
    'should freeze Function.prototype',
    'should not persist prototype pollution across executions',
    // globalThis sealing — container doesn't seal globalThis
    'should prevent adding new globals when globalThis is sealed',
    // codemode namespace protection — container uses different binding
    'should prevent overwriting codemode namespace',
    'should protect codemode from reassignment',
    // dynamic import — full Node.js inside container may allow it
    'should block dynamic import',
    // Performance tests — worker thread per call is slower than in-process
    'should execute simple code quickly',
    'should handle multiple sequential executions',
    // Concurrency tests — container executor serializes executions
    'should handle multiple concurrent executions',
    'should isolate data between concurrent executions',
    // BigInt serialization — BigInt doesn't survive JSON roundtrip
    'should handle BigInt arithmetic',
  ],
  testTimeout: 30000,
});

// Check Deno availability
let isDenoAvailable = false;
try {
  execSync('deno --version', { stdio: 'ignore' });
  isDenoAvailable = true;
} catch {
  // Deno not found in PATH
}

// Run test suite against Deno executor if available
if (isDenoAvailable) {
  createExecutorTestSuite('deno', () => createDenoExecutor(), {
    skipTests: [
      // JSON serialization boundary: undefined becomes null over the wire
      'should return undefined for no return statement',
      'should block prototype pollution',
      // Prototype freezing tests — runner doesn't freeze prototypes
      'should freeze Array.prototype',
      'should freeze Function.prototype',
      'should not persist prototype pollution across executions',
      // globalThis sealing — runner doesn't seal globalThis
      'should prevent adding new globals when globalThis is sealed',
      // codemode namespace protection — runner uses different binding
      'should prevent overwriting codemode namespace',
      'should protect codemode from reassignment',
      // dynamic import — Deno allows import('node:...') even with restrictions
      'should block dynamic import',
      // Performance tests — worker thread per call is slower than in-process
      'should execute simple code quickly',
      'should handle multiple sequential executions',
      // Concurrency tests — deno executor serializes executions
      'should handle multiple concurrent executions',
      'should isolate data between concurrent executions',
      // BigInt serialization — BigInt doesn't survive JSON roundtrip
      'should handle BigInt arithmetic',
    ],
    testTimeout: 30000,
  });
}
