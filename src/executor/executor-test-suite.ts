import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Executor, ExecuteResult } from '@cloudflare/codemode';

/**
 * Universal executor test suite
 * 
 * This suite can be run against any Executor implementation to verify
 * compliance with the standard interface and behavior expectations.
 * 
 * Usage:
 * ```typescript
 * import { createVM2Executor } from './vm2-executor';
 * import { createExecutorTestSuite } from './executor.test';
 * 
 * createExecutorTestSuite('vm2', () => createVM2Executor());
 * ```
 */

export interface ExecutorTestSuiteOptions {
  /** Test names to skip (exact match against it() description) */
  skipTests?: string[];
  /** Per-test timeout in ms (default: vitest default) */
  testTimeout?: number;
}

export function createExecutorTestSuite(
  name: string,
  createExecutor: () => Executor,
  options?: ExecutorTestSuiteOptions
) {
  const skipSet = new Set(options?.skipTests ?? []);
  /** Use it.skip for tests in the skip list, it otherwise */
  const testOrSkip = (testName: string, fn: () => Promise<void> | void) => {
    if (skipSet.has(testName)) {
      it.skip(testName, fn);
    } else {
      it(testName, fn, options?.testTimeout);
    }
  };

  describe(`Executor: ${name}`, () => {
    let executor: Executor;

    beforeAll(async () => {
      executor = createExecutor();
      // If executor has a lazy init (e.g. container), trigger it now so the
      // startup cost is not counted against the first test's timeout.
      if ('init' in executor && typeof (executor as any).init === 'function') {
        await (executor as any).init();
      }
    }, options?.testTimeout ? options.testTimeout * 2 : undefined);

    afterAll(async () => {
      // Cleanup if executor has dispose method
      if ('dispose' in executor && typeof executor.dispose === 'function') {
        await Promise.resolve((executor.dispose as () => void)());
      }
    });

    describe('Basic Execution', () => {
      testOrSkip('should execute simple arithmetic', async () => {
        const result = await executor.execute('return 1 + 2;', {});
        expect(result.result).toBe(3);
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should execute async code', async () => {
        const result = await executor.execute(
          `
          const promise = new Promise(resolve => 
            setTimeout(() => resolve(42), 10)
          );
          return await promise;
          `,
          {}
        );
        expect(result.result).toBe(42);
      });

      testOrSkip('should return undefined for no return statement', async () => {
        const result = await executor.execute('const x = 5;', {});
        expect(result.result).toBeUndefined();
      });

      testOrSkip('should handle string returns', async () => {
        const result = await executor.execute('return "hello";', {});
        expect(result.result).toBe('hello');
      });

      testOrSkip('should handle object returns', async () => {
        const result = await executor.execute(
          'return { a: 1, b: "two", c: [1, 2, 3] };',
          {}
        );
        expect(result.result).toEqual({
          a: 1,
          b: 'two',
          c: [1, 2, 3],
        });
      });
    });

    describe('Console Logging', () => {
      testOrSkip('should capture console.log output', async () => {
        const result = await executor.execute(
          `
          console.log('Hello');
          console.log('World');
          return 'done';
          `,
          {}
        );
        expect(result.logs).toContain('Hello');
        expect(result.logs).toContain('World');
      });

      testOrSkip('should capture multiple arguments', async () => {
        const result = await executor.execute(
          `console.log('Result:', 42, { key: 'value' });`,
          {}
        );
        expect(result.logs?.[0]).toContain('Result');
        expect(result.logs?.[0]).toContain('42');
      });

      testOrSkip('should not include logs key when empty', async () => {
        const result = await executor.execute('return 5;', {});
        expect(result.logs).toBeUndefined();
      });
    });

    describe('Error Handling', () => {
      testOrSkip('should catch syntax errors', async () => {
        const result = await executor.execute('this is not valid js', {});
        expect(result.error).toBeDefined();
        expect(result.result).toBeUndefined();
      });

      testOrSkip('should catch runtime errors', async () => {
        const result = await executor.execute(
          'throw new Error("Test error");',
          {}
        );
        expect(result.error).toContain('Test error');
        expect(result.result).toBeUndefined();
      });

      testOrSkip('should catch reference errors', async () => {
        const result = await executor.execute(
          'return nonExistentVariable;',
          {}
        );
        expect(result.error).toBeDefined();
      });

      testOrSkip('should not throw exceptions, return them', async () => {
        // Verify that the executor doesn't throw, only returns errors
        const promise = executor.execute(
          'throw new Error("Should not throw");',
          {}
        );
        await expect(promise).resolves.toHaveProperty('error');
      });
    });

    describe('Tool Invocation', () => {
      testOrSkip('should invoke tool functions', async () => {
        const mockTool = vi.fn(async () => 42);

        const result = await executor.execute(
          'return await codemode.myTool();',
          { myTool: mockTool }
        );

        expect(result.result).toBe(42);
        expect(mockTool).toHaveBeenCalled();
      });

      testOrSkip('should pass arguments to tool functions', async () => {
        const mockTool = vi.fn(async (a: number, b: number) => a + b);

        const result = await executor.execute(
          'return await codemode.add(5, 3);',
          { add: mockTool as unknown as (...args: unknown[]) => Promise<unknown> }
        );

        expect(result.result).toBe(8);
        expect(mockTool).toHaveBeenCalledWith(5, 3);
      });

      testOrSkip('should support tool with object arguments', async () => {
        const mockTool = vi.fn(async (opts: { name: string; value: number }) =>
          `${opts.name}=${opts.value}`
        );

        const result = await executor.execute(
          'return await codemode.format({ name: "test", value: 123 });',
          { format: mockTool as unknown as (...args: unknown[]) => Promise<unknown> }
        );

        expect(result.result).toBe('test=123');
        expect(mockTool).toHaveBeenCalledWith({
          name: 'test',
          value: 123,
        });
      });

      testOrSkip('should handle async tool errors', async () => {
        const mockTool = vi.fn(async () => {
          throw new Error('Tool failed');
        });

        const result = await executor.execute(
          `
          try {
            await codemode.failingTool();
            return 'should not reach here';
          } catch (e) {
            return 'caught: ' + e.message;
          }
          `,
          { failingTool: mockTool }
        );

        expect(result.result).toContain('caught');
      });
    });

    describe('Complex Code Patterns', () => {
      testOrSkip('should handle for loops', async () => {
        const result = await executor.execute(
          `
          let sum = 0;
          for (let i = 0; i < 10; i++) {
            sum += i;
          }
          return sum;
          `,
          {}
        );
        expect(result.result).toBe(45);
      });

      testOrSkip('should handle map/filter/reduce', async () => {
        const result = await executor.execute(
          `
          const arr = [1, 2, 3, 4, 5];
          return arr
            .filter(x => x > 2)
            .map(x => x * 2)
            .reduce((a, b) => a + b, 0);
          `,
          {}
        );
        expect(result.result).toBe(24); // (3+4+5) * 2 = 24
      });

      testOrSkip('should handle try-catch', async () => {
        const result = await executor.execute(
          `
          try {
            throw new Error('Caught!');
          } catch (e) {
            return e.message;
          }
          `,
          {}
        );
        expect(result.result).toBe('Caught!');
      });

      testOrSkip('should handle class definitions', async () => {
        const result = await executor.execute(
          `
          class Counter {
            constructor(start = 0) {
              this.count = start;
            }
            increment() {
              return ++this.count;
            }
          }
          const c = new Counter(5);
          return c.increment();
          `,
          {}
        );
        expect(result.result).toBe(6);
      });

      testOrSkip('should handle async/await chains', async () => {
        const mockFetch = vi.fn(async (id: number) => ({ id, name: `Item ${id}` }));

        const result = await executor.execute(
          `
          const item1 = await codemode.fetch(1);
          const item2 = await codemode.fetch(2);
          return [item1, item2];
          `,
          { fetch: mockFetch as unknown as (...args: unknown[]) => Promise<unknown> }
        );

        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result).toHaveLength(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });

    describe('Isolation & Safety', () => {
      testOrSkip('should not allow access to require', async () => {
        const result = await executor.execute(
          'return require("fs");',
          {}
        );
        expect(result.error).toBeDefined();
      });

      testOrSkip('should not allow process access', async () => {
        const result = await executor.execute(
          'return process.env;',
          {}
        );
        expect(result.error).toBeDefined();
      });

      testOrSkip('should not allow eval', async () => {
        const result = await executor.execute(
          'return eval("1+1");',
          {}
        );
        expect(result.error).toBeDefined();
      });

      testOrSkip('should not allow constructor to escape', async () => {
        const result = await executor.execute(
          'return (function(){}).constructor("return process")();',
          {}
        );
        expect(result.error).toBeDefined();
      });

      testOrSkip('should not allow network access', async () => {
        // All executors must prevent outbound network access:
        // - vm2/isolated-vm: no require/fetch/net globals available
        // - container: --network=none blocks at OS level
        const result = await executor.execute(
          `
          // Try multiple network vectors
          if (typeof fetch === 'function') {
            await fetch('https://example.com');
            return 'network allowed via fetch';
          }
          if (typeof require === 'function') {
            const http = require('http');
            await new Promise((resolve, reject) => {
              http.get('http://example.com', resolve).on('error', reject);
            });
            return 'network allowed via http';
          }
          // If neither is available, that itself is blocking network access
          throw new Error('no network APIs available');
          `,
          {}
        );
        // Must either error or return no success indicator
        if (result.error) {
          // Good — network was blocked or APIs unavailable
          expect(result.error).toBeDefined();
        } else {
          // Should never reach here with 'network allowed' messages
          expect(result.result).not.toBe('network allowed via fetch');
          expect(result.result).not.toBe('network allowed via http');
        }
      });

      testOrSkip('should not allow low-level socket network access', async () => {
        // Validates that raw TCP/UDP socket APIs are blocked.
        // - vm2/isolated-vm: require/net/dgram not available
        // - container: --network=none blocks at OS level even if APIs exist
        const result = await executor.execute(
          `
          if (typeof require === 'function') {
            // Try net.Socket (TCP)
            try {
              const net = require('net');
              await new Promise((resolve, reject) => {
                const sock = new net.Socket();
                sock.setTimeout(2000);
                sock.on('error', reject);
                sock.on('timeout', () => reject(new Error('timeout')));
                sock.connect(80, '1.1.1.1', resolve);
              });
              return 'network allowed via net.Socket';
            } catch (e) {}

            // Try dgram (UDP)
            try {
              const dgram = require('dgram');
              const sock = dgram.createSocket('udp4');
              await new Promise((resolve, reject) => {
                sock.on('error', reject);
                sock.send('ping', 53, '1.1.1.1', (err) => {
                  sock.close();
                  err ? reject(err) : resolve();
                });
              });
              return 'network allowed via dgram';
            } catch (e) {}

            // Try tls.connect
            try {
              const tls = require('tls');
              await new Promise((resolve, reject) => {
                const sock = tls.connect(443, '1.1.1.1', {}, resolve);
                sock.on('error', reject);
              });
              return 'network allowed via tls';
            } catch (e) {}

            // Try dns.resolve
            try {
              const dns = require('dns');
              await new Promise((resolve, reject) => {
                dns.resolve('example.com', (err, addresses) => {
                  err ? reject(err) : resolve(addresses);
                });
              });
              return 'network allowed via dns';
            } catch (e) {}

            // All low-level socket APIs failed — network is blocked
            throw new Error('all socket APIs blocked by network isolation');
          }
          // No require means no access to socket APIs at all
          throw new Error('no require available');
          `,
          {}
        );
        if (result.error) {
          expect(result.error).toBeDefined();
        } else {
          expect(result.result).not.toBe('network allowed via net.Socket');
          expect(result.result).not.toBe('network allowed via dgram');
          expect(result.result).not.toBe('network allowed via tls');
          expect(result.result).not.toBe('network allowed via dns');
        }
      });

      testOrSkip('should block prototype pollution', async () => {
        // Prototypes are frozen — Object.assign(Object.prototype, ...) must
        // either throw or silently fail, and the pollution must not take effect.
        const result = await executor.execute(
          `
          try {
            Object.assign(Object.prototype, { polluted: true });
          } catch (e) {
            // Throws in strict mode — expected
          }
          const obj = {};
          return obj.polluted;
          `,
          {}
        );
        // Pollution must not have taken effect
        expect(result.result).toBeUndefined();
        expect(result.error).toBeUndefined();
      });
    });

    describe('Concurrency', () => {
      testOrSkip('should handle multiple concurrent executions', async () => {
        const promises = Array.from({ length: 5 }, (_, i) =>
          executor.execute(`return ${i * 10};`, {})
        );

        const results = await Promise.all(promises);

        results.forEach((result, i) => {
          expect(result.result).toBe(i * 10);
        });
      });

      testOrSkip('should isolate data between concurrent executions', async () => {
        const promises = Array.from({ length: 3 }, (_, i) =>
          executor.execute(
            `
            global.sharedValue = ${i};
            return global.sharedValue;
            `,
            {}
          )
        );

        const results = await Promise.all(promises);

        // Each should return its own value, not shared
        results.forEach((result, i) => {
          expect(result.result).toBe(i);
        });
      });
    });

    describe('Performance Baseline', () => {
      testOrSkip('should execute simple code quickly', async () => {
        const start = performance.now();
        await executor.execute('return 1 + 1;', {});
        const elapsed = performance.now() - start;

        // Simple execution should be <100ms
        expect(elapsed).toBeLessThan(100);
      });

      testOrSkip('should handle multiple sequential executions', async () => {
        const start = performance.now();

        for (let i = 0; i < 10; i++) {
          await executor.execute(`return ${i};`, {});
        }

        const elapsed = performance.now() - start;

        // 10 executions should be <500ms total
        expect(elapsed).toBeLessThan(500);
      });
    });
  });
}

// Run the test suite against both executors if available
if (require.main === module) {
  // Import and run against vm2
  try {
    const { createVM2Executor } = require('./vm2-executor');
    createExecutorTestSuite('vm2', () => createVM2Executor());
  } catch (e) {
    console.log('vm2 executor not available');
  }

  // Import and run against isolated-vm
  try {
    const { createIsolatedVmExecutor } = require('./isolated-vm-executor');
    createExecutorTestSuite('isolated-vm', () =>
      createIsolatedVmExecutor({ memoryLimit: 256 })
    );
  } catch (e) {
    console.log('isolated-vm executor not available');
  }
}
