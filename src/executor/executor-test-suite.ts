import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Executor, ExecuteResult } from '@cloudflare/codemode';
import { getRuntimeName } from '../utils/env.js';

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
    console.log(`[Test] Runtime: ${getRuntimeName()}`);
    let executor: Executor;

    beforeAll(async () => {
      const t0 = Date.now();
      console.log('[Executor] beforeAll: starting setup...');

      console.log('[Executor] beforeAll: creating executor...');
      executor = createExecutor();
      console.log(`[Executor] beforeAll: executor created (+${Date.now() - t0}ms), initialising...`);

      // If executor has a lazy init (e.g. container), trigger it now so the
      // startup cost is not counted against the first test's timeout.
      if ('init' in executor && typeof (executor as any).init === 'function') {
        await (executor as any).init();
      }
      console.log(`[Executor] beforeAll: setup complete (+${Date.now() - t0}ms)`);
    }, options?.testTimeout ? Math.max(options.testTimeout * 2, 120_000) : 120_000);

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

      testOrSkip('should handle parallel tool calls with Promise.all', async () => {
        const mockTool = vi.fn(async (id: number) => ({ id, name: `Item ${id}` }));

        const result = await executor.execute(
          `
          const results = await Promise.all([
            codemode.fetchItem(1),
            codemode.fetchItem(2),
            codemode.fetchItem(3),
          ]);
          return results;
          `,
          { fetchItem: mockTool as unknown as (...args: unknown[]) => Promise<unknown> }
        );

        expect(result.error).toBeUndefined();
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result).toHaveLength(3);
        expect(mockTool).toHaveBeenCalledTimes(3);
        expect((result.result as any[])[0]).toEqual({ id: 1, name: 'Item 1' });
        expect((result.result as any[])[2]).toEqual({ id: 3, name: 'Item 3' });
      });

      testOrSkip('should protect codemode from reassignment', async () => {
        const mockTool = vi.fn(async () => 'original');

        const result = await executor.execute(
          `
          try {
            codemode = { hijacked: true };
          } catch (e) {
            // Expected — codemode is non-configurable / non-writable
          }
          // The real codemode should still work
          return await codemode.myTool();
          `,
          { myTool: mockTool }
        );

        expect(result.error).toBeUndefined();
        expect(result.result).toBe('original');
        expect(mockTool).toHaveBeenCalled();
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

      testOrSkip('should handle Promise.allSettled', async () => {
        const result = await executor.execute(
          `
          const results = await Promise.allSettled([
            Promise.resolve('ok'),
            Promise.reject(new Error('fail')),
            Promise.resolve(42),
          ]);
          return results.map(r => ({
            status: r.status,
            value: r.status === 'fulfilled' ? r.value : undefined,
            reason: r.status === 'rejected' ? r.reason.message : undefined,
          }));
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        const arr = result.result as any[];
        expect(arr).toHaveLength(3);
        expect(arr[0]).toEqual({ status: 'fulfilled', value: 'ok', reason: undefined });
        expect(arr[1]).toEqual({ status: 'rejected', value: undefined, reason: 'fail' });
        expect(arr[2]).toEqual({ status: 'fulfilled', value: 42, reason: undefined });
      });

      testOrSkip('should handle Promise.withResolvers', async () => {
        // Promise.withResolvers is ES2024 — available in Node 22+
        const result = await executor.execute(
          `
          if (typeof Promise.withResolvers !== 'function') {
            return 'unsupported';
          }
          const { promise, resolve } = Promise.withResolvers();
          resolve(99);
          return await promise;
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        if (result.result === 'unsupported') {
          // Engine doesn't support withResolvers, that's fine
          return;
        }
        expect(result.result).toBe(99);
      });

      testOrSkip('should handle async generators', async () => {
        const result = await executor.execute(
          `
          async function* gen() {
            yield 1;
            yield 2;
            yield 3;
          }
          const values = [];
          for await (const v of gen()) {
            values.push(v);
          }
          return values;
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual([1, 2, 3]);
      });

      testOrSkip('should handle closures and currying', async () => {
        const result = await executor.execute(
          `
          function multiply(a) {
            return function(b) {
              return a * b;
            };
          }
          const double = multiply(2);
          const triple = multiply(3);
          return [double(5), triple(5)];
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual([10, 15]);
      });

      testOrSkip('should handle sync generators', async () => {
        const result = await executor.execute(
          `
          function* fibonacci() {
            let a = 0, b = 1;
            while (true) {
              yield a;
              [a, b] = [b, a + b];
            }
          }
          const fib = fibonacci();
          const values = [];
          for (let i = 0; i < 8; i++) {
            values.push(fib.next().value);
          }
          return values;
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual([0, 1, 1, 2, 3, 5, 8, 13]);
      });

      testOrSkip('should handle error cause chaining', async () => {
        const result = await executor.execute(
          `
          try {
            try {
              throw new Error('root cause');
            } catch (e) {
              throw new Error('wrapper', { cause: e });
            }
          } catch (e) {
            return {
              message: e.message,
              causeMessage: e.cause?.message,
            };
          }
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          message: 'wrapper',
          causeMessage: 'root cause',
        });
      });
    });

    describe('Isolation & Safety', () => {
      testOrSkip('should not allow access to require', async () => {
        const result = await executor.execute(
          'return require("node:fs");',
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
            const http = require('node:http');
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
              const net = require('node:net');
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
              const dgram = require('node:dgram');
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
              const tls = require('node:tls');
              await new Promise((resolve, reject) => {
                const sock = tls.connect(443, '1.1.1.1', {}, resolve);
                sock.on('error', reject);
              });
              return 'network allowed via tls';
            } catch (e) {}

            // Try dns.resolve
            try {
              const dns = require('node:dns');
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

      testOrSkip('should freeze Array.prototype', async () => {
        const result = await executor.execute(
          `
          try {
            Array.prototype.myCustomMethod = () => 'injected';
          } catch (e) {
            return 'blocked';
          }
          return typeof [].myCustomMethod === 'function' ? 'polluted' : 'blocked';
          `,
          {}
        );
        expect(result.result).toBe('blocked');
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should freeze Function.prototype', async () => {
        const result = await executor.execute(
          `
          try {
            Function.prototype.myCustomMethod = () => 'injected';
          } catch (e) {
            return 'blocked';
          }
          return typeof (function(){}).myCustomMethod === 'function' ? 'polluted' : 'blocked';
          `,
          {}
        );
        expect(result.result).toBe('blocked');
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should prevent adding new globals when globalThis is sealed', async () => {
        const result = await executor.execute(
          `
          try {
            globalThis.sneakyGlobal = 42;
          } catch (e) {
            return 'blocked';
          }
          return typeof globalThis.sneakyGlobal !== 'undefined' ? 'leaked' : 'blocked';
          `,
          {}
        );
        expect(result.result).toBe('blocked');
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should prevent overwriting codemode namespace', async () => {
        const result = await executor.execute(
          `
          try {
            codemode = { hijacked: true };
          } catch (e) {
            return 'blocked';
          }
          return typeof codemode.hijacked !== 'undefined' ? 'overwritten' : 'blocked';
          `,
          {}
        );
        expect(result.result).toBe('blocked');
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should hide internal state from enumeration', async () => {
        // Internal sandbox mechanisms should not be enumerable on globalThis
        const result = await executor.execute(
          `
          const keys = Object.keys(globalThis);
          // Should not expose internal mechanisms like __resolveResult, __callTool, etc.
          const internalKeys = keys.filter(k => k.startsWith('__'));
          return internalKeys;
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual([]);
      });

      testOrSkip('should block dynamic import', async () => {
        const result = await executor.execute(
          `
          try {
            const m = await import('node:fs');
            return 'import allowed';
          } catch (e) {
            return 'blocked';
          }
          `,
          {}
        );
        expect(result.result).toBe('blocked');
        expect(result.error).toBeUndefined();
      });

      testOrSkip('should not persist prototype pollution across executions', async () => {
        // First execution: attempt to pollute
        await executor.execute(
          `
          try { Object.prototype.crossExecPollution = 'leaked'; } catch(e) {}
          `,
          {}
        );
        // Second execution: check if pollution persists
        const result = await executor.execute(
          `
          const obj = {};
          return typeof obj.crossExecPollution;
          `,
          {}
        );
        expect(result.result).toBe('undefined');
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

    describe('Data Structures & Serialization', () => {
      testOrSkip('should handle regex named groups', async () => {
        const result = await executor.execute(
          `
          const re = /(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})/;
          const match = re.exec('2026-02-25');
          return {
            year: match.groups.year,
            month: match.groups.month,
            day: match.groups.day,
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({ year: '2026', month: '02', day: '25' });
      });

      testOrSkip('should handle modern array methods', async () => {
        const result = await executor.execute(
          `
          const arr = [1, [2, [3, [4]]]];
          const flat = arr.flat(Infinity);
          const atResult = flat.at(-1);
          const findLastResult = flat.findLast(x => x % 2 === 0);
          return { flat, atResult, findLastResult };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          flat: [1, 2, 3, 4],
          atResult: 4,
          findLastResult: 4,
        });
      });

      testOrSkip('should handle Object.groupBy', async () => {
        const result = await executor.execute(
          `
          if (typeof Object.groupBy !== 'function') {
            return 'unsupported';
          }
          const items = [
            { type: 'fruit', name: 'apple' },
            { type: 'veg', name: 'carrot' },
            { type: 'fruit', name: 'banana' },
          ];
          const grouped = Object.groupBy(items, item => item.type);
          return {
            fruitCount: grouped.fruit.length,
            vegCount: grouped.veg.length,
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        if (result.result === 'unsupported') return;
        expect(result.result).toEqual({ fruitCount: 2, vegCount: 1 });
      });

      testOrSkip('should handle Map and Set', async () => {
        const result = await executor.execute(
          `
          const map = new Map();
          map.set('a', 1);
          map.set('b', 2);
          map.set('c', 3);
          const set = new Set([1, 2, 2, 3, 3, 3]);
          return {
            mapSize: map.size,
            mapEntries: Array.from(map.entries()),
            setSize: set.size,
            setValues: Array.from(set.values()),
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          mapSize: 3,
          mapEntries: [['a', 1], ['b', 2], ['c', 3]],
          setSize: 3,
          setValues: [1, 2, 3],
        });
      });

      testOrSkip('should handle JSON replacer and reviver', async () => {
        const result = await executor.execute(
          `
          const data = { name: 'test', secret: 'hidden', count: 5 };
          const filtered = JSON.stringify(data, (key, val) =>
            key === 'secret' ? undefined : val
          );
          const parsed = JSON.parse('{"value":"42"}', (key, val) =>
            key === 'value' ? Number(val) : val
          );
          return { filtered: JSON.parse(filtered), parsed };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          filtered: { name: 'test', count: 5 },
          parsed: { value: 42 },
        });
      });

      testOrSkip('should handle JSON serialization edge cases', async () => {
        const result = await executor.execute(
          `
          return {
            nan: Number.isNaN(NaN),
            inf: !Number.isFinite(Infinity),
            negZero: Object.is(-0, -0),
            nullVal: null,
            emptyStr: '',
            emptyArr: [],
            emptyObj: {},
            nested: { a: { b: { c: 1 } } },
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        const r = result.result as any;
        expect(r.nan).toBe(true);
        expect(r.inf).toBe(true);
        expect(r.negZero).toBe(true);
        expect(r.nullVal).toBeNull();
        expect(r.emptyStr).toBe('');
        expect(r.emptyArr).toEqual([]);
        expect(r.emptyObj).toEqual({});
        expect(r.nested).toEqual({ a: { b: { c: 1 } } });
      });

      testOrSkip('should handle Date operations', async () => {
        const result = await executor.execute(
          `
          const d = new Date('2026-02-25T12:00:00Z');
          return {
            iso: d.toISOString(),
            year: d.getUTCFullYear(),
            month: d.getUTCMonth() + 1,
            day: d.getUTCDate(),
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          iso: '2026-02-25T12:00:00.000Z',
          year: 2026,
          month: 2,
          day: 25,
        });
      });

      testOrSkip('should handle BigInt arithmetic', async () => {
        const result = await executor.execute(
          `
          const a = BigInt('9007199254740993');
          const b = BigInt('9007199254740993');
          const sum = a + b;
          return {
            sumStr: sum.toString(),
            isLarger: sum > BigInt(Number.MAX_SAFE_INTEGER),
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        const r = result.result as any;
        expect(r.sumStr).toBe('18014398509481986');
        expect(r.isLarger).toBe(true);
      });
    });

    describe('Stress & Edge Cases', () => {
      testOrSkip('should handle deep nesting', async () => {
        const result = await executor.execute(
          `
          let obj = { value: 'deep' };
          for (let i = 0; i < 50; i++) {
            obj = { nested: obj };
          }
          let current = obj;
          for (let i = 0; i < 50; i++) {
            current = current.nested;
          }
          return current.value;
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toBe('deep');
      });

      testOrSkip('should handle memoization patterns', async () => {
        const result = await executor.execute(
          `
          function memoize(fn) {
            const cache = new Map();
            return function(...args) {
              const key = JSON.stringify(args);
              if (cache.has(key)) return cache.get(key);
              const result = fn(...args);
              cache.set(key, result);
              return result;
            };
          }
          let callCount = 0;
          const expensiveFn = memoize((n) => {
            callCount++;
            return n * n;
          });
          const results = [expensiveFn(5), expensiveFn(5), expensiveFn(3), expensiveFn(3)];
          return { results, callCount };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          results: [25, 25, 9, 9],
          callCount: 2, // Only 2 unique calls
        });
      });

      testOrSkip('should survive deep recursion', async () => {
        const result = await executor.execute(
          `
          function sumTo(n) {
            if (n <= 0) return 0;
            return n + sumTo(n - 1);
          }
          return sumTo(1000);
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toBe(500500);
      });

      testOrSkip('should handle large array operations', async () => {
        const result = await executor.execute(
          `
          const size = 10000;
          const arr = Array.from({ length: size }, (_, i) => i + 1);
          const sum = arr.reduce((a, b) => a + b, 0);
          const filtered = arr.filter(x => x % 2 === 0);
          return { sum, evenCount: filtered.length, last: arr.at(-1) };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          sum: 50005000,
          evenCount: 5000,
          last: 10000,
        });
      });

      testOrSkip('should handle Proxy and Reflect', async () => {
        const result = await executor.execute(
          `
          const handler = {
            get(target, prop) {
              if (prop in target) return target[prop];
              return 'default';
            },
            set(target, prop, value) {
              target[prop] = typeof value === 'string' ? value.toUpperCase() : value;
              return true;
            },
          };
          const obj = new Proxy({}, handler);
          obj.name = 'hello';
          return {
            name: obj.name,
            missing: obj.nonexistent,
          };
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          name: 'HELLO',
          missing: 'default',
        });
      });

      testOrSkip('should handle Symbol.iterator', async () => {
        const result = await executor.execute(
          `
          class Range {
            constructor(start, end) {
              this.start = start;
              this.end = end;
            }
            [Symbol.iterator]() {
              let current = this.start;
              const end = this.end;
              return {
                next() {
                  if (current <= end) {
                    return { value: current++, done: false };
                  }
                  return { done: true };
                },
              };
            }
          }
          return [...new Range(1, 5)];
          `,
          {}
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual([1, 2, 3, 4, 5]);
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
