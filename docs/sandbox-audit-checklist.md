# Sandbox Audit Checklist

Checklist derived from the [isolated-vm sandbox audit](./isolated-vm.md). Maps each audited
capability to automated test coverage in `executor-test-suite.ts`.

**Legend**: Covered = automated test exists | Gap = no automated test | N/A = not applicable

---

## 1. Basic Arithmetic and Math Operations

| Item | Test coverage | Status |
|------|---------------|--------|
| Simple arithmetic (`1 + 2`) | `should execute simple arithmetic` | Covered |
| Complex math (loops, accumulation) | `should handle for loops` | Covered |

## 2. String Manipulation and Regex

| Item | Test coverage | Status |
|------|---------------|--------|
| String returns | `should handle string returns` | Covered |
| Regex (named groups, lookahead/lookbehind, Unicode property escapes) | `should handle regex named groups` | Covered |

## 3. Array/Object Operations and Data Structures

| Item | Test coverage | Status |
|------|---------------|--------|
| Object returns | `should handle object returns` | Covered |
| `Array.filter/map/reduce` | `should handle map/filter/reduce` | Covered |
| ES2024 array methods (`flat`, `at`, `findLast`) | `should handle modern array methods` | Covered |
| `Object.groupBy` | `should handle Object.groupBy` | Covered |
| Map, Set | `should handle Map and Set` | Covered |
| Symbol, custom iterators | `should handle Symbol.iterator` | Covered |
| Proxy and Reflect | `should handle Proxy and Reflect` | Covered (skipped on vm2 — Proxy unavailable) |

## 4. Async/Await and Promise Patterns

| Item | Test coverage | Status |
|------|---------------|--------|
| Basic async/await | `should execute async code` | Covered |
| Async tool chaining (sequential) | `should handle async/await chains` | Covered |
| `Promise.all` / parallel execution | `should handle multiple concurrent executions`, `should handle parallel tool calls with Promise.all` | Covered |
| `Promise.allSettled` | `should handle Promise.allSettled` | Covered |
| `Promise.withResolvers()` | `should handle Promise.withResolvers` | Covered (graceful fallback if unsupported) |
| Async generators, `for await...of` | `should handle async generators` | Covered |

## 5. Error Handling and Edge Cases

| Item | Test coverage | Status |
|------|---------------|--------|
| Syntax errors | `should catch syntax errors` | Covered |
| Runtime errors (`throw`) | `should catch runtime errors` | Covered |
| Reference errors | `should catch reference errors` | Covered |
| Errors returned (not thrown) | `should not throw exceptions, return them` | Covered |
| Async tool errors (caught) | `should handle async tool errors` | Covered |
| Try-catch | `should handle try-catch` | Covered |
| Error cause chaining (ES2022) | `should handle error cause chaining` | Covered |
| `undefined` return | `should return undefined for no return statement` | Covered |

## 6. Complex Algorithms

| Item | Test coverage | Status |
|------|---------------|--------|
| Class definitions | `should handle class definitions` | Covered |
| Closures and currying | `should handle closures and currying` | Covered |
| BigInt arithmetic | `should handle BigInt arithmetic` | Covered |
| Memoization | `should handle memoization patterns` | Covered |
| Deep recursion | `should survive deep recursion` | Covered |

## 7. JSON Processing and Data Transformation

| Item | Test coverage | Status |
|------|---------------|--------|
| Object/array serialization across boundary | `should handle object returns` | Covered |
| `JSON.parse`/`JSON.stringify` with replacer/reviver | `should handle JSON replacer and reviver` | Covered |
| Serialization edge cases (NaN, Infinity, null, empty) | `should handle JSON serialization edge cases` | Covered |

## 8. Date/Time Operations

| Item | Test coverage | Status |
|------|---------------|--------|
| Date API | `should handle Date operations` | Covered |

## 9. Closures, Higher-Order Functions, Generators

| Item | Test coverage | Status |
|------|---------------|--------|
| Closures, currying | `should handle closures and currying` | Covered |
| Sync generators | `should handle sync generators` | Covered |
| Async generators | `should handle async generators` | Covered |
| Deep nesting (50+ levels) | `should handle deep nesting` | Covered |

## 10. Stress Test (Large Data, Nested Ops, Chaining)

| Item | Test coverage | Status |
|------|---------------|--------|
| Large array operations (10k elements) | `should handle large array operations` | Covered |
| Max recursion depth (1000 levels) | `should survive deep recursion` | Covered |
| Memoization patterns | `should handle memoization patterns` | Covered |
| Deep nesting (50 levels) | `should handle deep nesting` | Covered |

## 11. MCP Tool Integration

| Item | Test coverage | Status |
|------|---------------|--------|
| Tool invocation (no args) | `should invoke tool functions` | Covered |
| Tool with positional args | `should pass arguments to tool functions` | Covered |
| Tool with object args | `should support tool with object arguments` | Covered |
| Tool error handling | `should handle async tool errors` | Covered |
| Sequential tool chaining (output → input) | `should handle async/await chains` | Covered |
| Parallel tool execution (`Promise.all`) | `should handle parallel tool calls with Promise.all` | Covered |
| `codemode` monkey-patch protection | `should protect codemode from reassignment`, `should prevent overwriting codemode namespace` | Covered |

## 12. Security Boundary Tests

| Audit item | Test coverage | Status |
|------------|---------------|--------|
| `require("fs")` blocked | `should not allow access to require` | Covered |
| `await import("fs")` blocked | `should block dynamic import` | Covered |
| `eval("...")` blocked | `should not allow eval` | Covered |
| `Function` constructor blocked | `should not allow constructor to escape` | Covered |
| `fetch` / `XMLHttpRequest` / `WebSocket` blocked | `should not allow network access` | Covered |
| `process` / `process.env` / `process.exit` blocked | `should not allow process access` | Covered |
| Low-level sockets (`net`, `dgram`, `tls`, `dns`) blocked | `should not allow low-level socket network access` | Covered |
| `Object.prototype` frozen (pollution blocked) | `should block prototype pollution` | Covered |
| `Array.prototype` frozen | `should freeze Array.prototype` | Covered |
| `Function.prototype` frozen | `should freeze Function.prototype` | Covered |
| `globalThis` sealed (isolated-vm only) | `should prevent adding new globals when globalThis is sealed` | Covered (skipped on vm2/container) |
| `codemode` non-configurable / non-writable | `should prevent overwriting codemode namespace`, `should protect codemode from reassignment` | Covered |
| Internal state non-enumerable (`_pendingResolvers`, etc.) | `should hide internal state from enumeration` | Covered |
| Cross-call isolation (no mutation persistence) | `should not persist prototype pollution across executions`, `should isolate data between concurrent executions` | Covered |

---

## Summary

| Category | Total items | Covered | Gaps |
|----------|-------------|---------|------|
| 1. Basic arithmetic | 2 | 2 | 0 |
| 2. String/regex | 2 | 2 | 0 |
| 3. Array/Object/data structures | 7 | 7 | 0 |
| 4. Async/Promise | 6 | 6 | 0 |
| 5. Error handling | 8 | 8 | 0 |
| 6. Complex algorithms | 5 | 5 | 0 |
| 7. JSON processing | 3 | 3 | 0 |
| 8. Date/time | 1 | 1 | 0 |
| 9. Closures/generators | 4 | 4 | 0 |
| 10. Stress test | 4 | 4 | 0 |
| 11. MCP tool integration | 7 | 7 | 0 |
| 12. Security boundaries | 14 | 14 | 0 |
| **Total** | **63** | **63** | **0** |

All gaps identified in the original audit have been closed.

### Skip list summary

Tests skipped per executor (not gaps — architecture-appropriate exclusions):

| Executor | Skipped | Reason |
|----------|---------|--------|
| vm2 | 2 | `globalThis` seal (proxy-based sandbox), `Proxy` constructor (not exposed) |
| isolated-vm | 1 | Concurrent global assignment (sealed context) |
| container | 18 | JS-level isolation N/A (OS-level), performance/concurrency (worker thread overhead), BigInt serialization |
