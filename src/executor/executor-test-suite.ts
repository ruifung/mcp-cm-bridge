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
export function createExecutorTestSuite(
  name: string,
  createExecutor: () => Executor
) {
  describe(`Executor: ${name}`, () => {
    let executor: Executor;

    beforeAll(() => {
      executor = createExecutor();
    });

    afterAll(() => {
      // Cleanup if executor has dispose method
      if ('dispose' in executor && typeof executor.dispose === 'function') {
        (executor.dispose as () => void)();
      }
    });

    describe('Basic Execution', () => {
      it('should execute simple arithmetic', async () => {
        const result = await executor.execute('return 1 + 2;', {});
        expect(result.result).toBe(3);
        expect(result.error).toBeUndefined();
      });

      it('should execute async code', async () => {
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

      it('should return undefined for no return statement', async () => {
        const result = await executor.execute('const x = 5;', {});
        expect(result.result).toBeUndefined();
      });

      it('should handle string returns', async () => {
        const result = await executor.execute('return "hello";', {});
        expect(result.result).toBe('hello');
      });

      it('should handle object returns', async () => {
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
      it('should capture console.log output', async () => {
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

      it('should capture multiple arguments', async () => {
        const result = await executor.execute(
          `console.log('Result:', 42, { key: 'value' });`,
          {}
        );
        expect(result.logs?.[0]).toContain('Result');
        expect(result.logs?.[0]).toContain('42');
      });

      it('should not include logs key when empty', async () => {
        const result = await executor.execute('return 5;', {});
        expect(result.logs).toBeUndefined();
      });
    });

    describe('Error Handling', () => {
      it('should catch syntax errors', async () => {
        const result = await executor.execute('this is not valid js', {});
        expect(result.error).toBeDefined();
        expect(result.result).toBeUndefined();
      });

      it('should catch runtime errors', async () => {
        const result = await executor.execute(
          'throw new Error("Test error");',
          {}
        );
        expect(result.error).toContain('Test error');
        expect(result.result).toBeUndefined();
      });

      it('should catch reference errors', async () => {
        const result = await executor.execute(
          'return nonExistentVariable;',
          {}
        );
        expect(result.error).toBeDefined();
      });

      it('should not throw exceptions, return them', async () => {
        // Verify that the executor doesn't throw, only returns errors
        const promise = executor.execute(
          'throw new Error("Should not throw");',
          {}
        );
        await expect(promise).resolves.toHaveProperty('error');
      });
    });

    describe('Tool Invocation', () => {
      it('should invoke tool functions', async () => {
        const mockTool = vi.fn(async () => 42);

        const result = await executor.execute(
          'return await codemode.myTool();',
          { myTool: mockTool }
        );

        expect(result.result).toBe(42);
        expect(mockTool).toHaveBeenCalled();
      });

      it('should pass arguments to tool functions', async () => {
        const mockTool = vi.fn(async (a: number, b: number) => a + b);

        const result = await executor.execute(
          'return await codemode.add(5, 3);',
          { add: mockTool as unknown as (...args: unknown[]) => Promise<unknown> }
        );

        expect(result.result).toBe(8);
        expect(mockTool).toHaveBeenCalledWith(5, 3);
      });

      it('should support tool with object arguments', async () => {
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

      it('should handle async tool errors', async () => {
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
      it('should handle for loops', async () => {
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

      it('should handle map/filter/reduce', async () => {
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

      it('should handle try-catch', async () => {
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

      it('should handle class definitions', async () => {
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

      it('should handle async/await chains', async () => {
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
      it('should not allow access to require', async () => {
        const result = await executor.execute(
          'return require("fs");',
          {}
        );
        expect(result.error).toBeDefined();
      });

      it('should not allow process access', async () => {
        const result = await executor.execute(
          'return process.env;',
          {}
        );
        expect(result.error).toBeDefined();
      });

      it('should not allow eval', async () => {
        const result = await executor.execute(
          'return eval("1+1");',
          {}
        );
        expect(result.error).toBeDefined();
      });

      it('should not allow constructor to escape', async () => {
        const result = await executor.execute(
          'return (function(){}).constructor("return process")();',
          {}
        );
        expect(result.error).toBeDefined();
      });

      it('should isolate prototype pollution to the current execution', async () => {
        // NOTE: Prototype pollution IS possible within a single execution,
        // but it is NOT a security risk because:
        // 1. Each execution gets a fresh sandbox with clean prototypes
        // 2. Pollution only affects that specific execution's globals
        // 3. Host code is protected by serialization boundaries (JSON.stringify)
        // 4. Next execution runs in a completely new sandbox
        
        // Test 1: Pollution works within execution (expected)
        const result1 = await executor.execute(
          `
          Object.assign(Object.prototype, { polluted: true });
          const obj = {};
          return obj.polluted;
          `,
          {}
        );
        expect(result1.result).toBe(true); // Pollution works within this execution
        
        // Test 2: Next execution has clean prototypes (this proves isolation)
        const result2 = await executor.execute(
          `
          const obj = {};
          return obj.polluted;
          `,
          {}
        );
        expect(result2.result).toBeUndefined(); // Fresh sandbox, no pollution
      });
    });

    describe('Concurrency', () => {
      it('should handle multiple concurrent executions', async () => {
        const promises = Array.from({ length: 5 }, (_, i) =>
          executor.execute(`return ${i * 10};`, {})
        );

        const results = await Promise.all(promises);

        results.forEach((result, i) => {
          expect(result.result).toBe(i * 10);
        });
      });

      it('should isolate data between concurrent executions', async () => {
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
      it('should execute simple code quickly', async () => {
        const start = performance.now();
        await executor.execute('return 1 + 1;', {});
        const elapsed = performance.now() - start;

        // Simple execution should be <100ms
        expect(elapsed).toBeLessThan(100);
      });

      it('should handle multiple sequential executions', async () => {
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
