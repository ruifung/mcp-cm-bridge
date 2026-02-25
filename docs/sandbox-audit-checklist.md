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
| Regex (named groups, lookahead/lookbehind, Unicode property escapes) | — | Gap |

## 3. Array/Object Operations and Data Structures

| Item | Test coverage | Status |
|------|---------------|--------|
| Object returns | `should handle object returns` | Covered |
| `Array.filter/map/reduce` | `should handle map/filter/reduce` | Covered |
| ES2024 array methods (`toSorted`, `toReversed`, `with`, `findLast`) | — | Gap |
| `Object.groupBy` | — | Gap |
| Map, Set, WeakRef, WeakMap | — | Gap |
| Symbol, custom iterators | — | Gap |
| Proxy and Reflect | — | Gap |

## 4. Async/Await and Promise Patterns

| Item | Test coverage | Status |
|------|---------------|--------|
| Basic async/await | `should execute async code` | Covered |
| Async tool chaining (sequential) | `should handle async/await chains` | Covered |
| `Promise.all` / parallel execution | `should handle multiple concurrent executions` | Covered |
| `Promise.allSettled` / `race` / `any` | — | Gap |
| `Promise.withResolvers()` | — | Gap |
| Async generators, `for await...of` | — | Gap |

## 5. Error Handling and Edge Cases

| Item | Test coverage | Status |
|------|---------------|--------|
| Syntax errors | `should catch syntax errors` | Covered |
| Runtime errors (`throw`) | `should catch runtime errors` | Covered |
| Reference errors | `should catch reference errors` | Covered |
| Errors returned (not thrown) | `should not throw exceptions, return them` | Covered |
| Async tool errors (caught) | `should handle async tool errors` | Covered |
| Try-catch | `should handle try-catch` | Covered |
| Error cause chaining (ES2022) | — | Gap |
| `undefined` return | `should return undefined for no return statement` | Covered |

## 6. Complex Algorithms

| Item | Test coverage | Status |
|------|---------------|--------|
| Class definitions | `should handle class definitions` | Covered |
| Quicksort, mergesort, DFS, BFS, sieve, matrix multiply, Levenshtein | — | Gap |
| BigInt arithmetic | — | Gap |

## 7. JSON Processing and Data Transformation

| Item | Test coverage | Status |
|------|---------------|--------|
| Object/array serialization across boundary | `should handle object returns` | Covered |
| `JSON.parse`/`JSON.stringify` with replacer/reviver | — | Gap |
| Serialization quirks (`Infinity` → `null`, `NaN` → `null`) | — | Gap |

## 8. Date/Time Operations

| Item | Test coverage | Status |
|------|---------------|--------|
| Date API | — | Gap |

## 9. Closures, Higher-Order Functions, Generators

| Item | Test coverage | Status |
|------|---------------|--------|
| Closures, currying, pipe/compose | — | Gap |
| Generators (sync and async) | — | Gap |
| Memoization | — | Gap |
| Deep nesting (50+ levels) | — | Gap |

## 10. Stress Test (Large Data, Nested Ops, Chaining)

| Item | Test coverage | Status |
|------|---------------|--------|
| 100k array sort + 50k Map + tree traversal + 1000 promises | — | Gap |
| Max recursion depth | — | Gap |
| Large string allocation (33M chars) | — | Gap |
| Large array allocation (10M elements) | — | Gap |

## 11. MCP Tool Integration

| Item | Test coverage | Status |
|------|---------------|--------|
| Tool invocation (no args) | `should invoke tool functions` | Covered |
| Tool with positional args | `should pass arguments to tool functions` | Covered |
| Tool with object args | `should support tool with object arguments` | Covered |
| Tool error handling | `should handle async tool errors` | Covered |
| Sequential tool chaining (output → input) | `should handle async/await chains` | Covered |
| Parallel tool execution (`Promise.all`) | — | Gap |
| `codemode` monkey-patch protection | — | Gap (partially via `should block prototype pollution`) |

## 12. Security Boundary Tests

| Audit item | Test coverage | Status |
|------------|---------------|--------|
| `require("fs")` blocked | `should not allow access to require` | Covered |
| `await import("fs")` blocked | — | Gap |
| `eval("...")` blocked | `should not allow eval` | Covered |
| `Function` constructor blocked | `should not allow constructor to escape` | Covered |
| `fetch` / `XMLHttpRequest` / `WebSocket` blocked | `should not allow network access` | Covered |
| `process` / `process.env` / `process.exit` blocked | `should not allow process access` | Covered |
| Low-level sockets (`net`, `dgram`, `tls`, `dns`) blocked | `should not allow low-level socket network access` | Covered |
| `Object.prototype` frozen (pollution blocked) | `should block prototype pollution` | Covered |
| `Array.prototype` frozen | — | Gap (only Object.prototype tested) |
| `Function.prototype` frozen | — | Gap |
| `globalThis` sealed (isolated-vm only) | — | Gap |
| `codemode` non-configurable / non-writable | — | Gap |
| Internal state non-enumerable (`_pendingResolvers`, etc.) | — | Gap |
| `protocol` non-enumerable (isolated-vm only) | — | Gap |
| Cross-call isolation (no mutation persistence) | `should isolate data between concurrent executions` | Partial (only tests `global.sharedValue`, not prototype/internal state) |

---

## Summary

| Category | Total items | Covered | Gaps |
|----------|-------------|---------|------|
| 1. Basic arithmetic | 2 | 2 | 0 |
| 2. String/regex | 2 | 1 | 1 |
| 3. Array/Object/data structures | 7 | 2 | 5 |
| 4. Async/Promise | 6 | 3 | 3 |
| 5. Error handling | 7 | 6 | 1 |
| 6. Complex algorithms | 3 | 1 | 2 |
| 7. JSON processing | 3 | 1 | 2 |
| 8. Date/time | 1 | 0 | 1 |
| 9. Closures/generators | 4 | 0 | 4 |
| 10. Stress test | 4 | 0 | 4 |
| 11. MCP tool integration | 7 | 5 | 2 |
| 12. Security boundaries | 15 | 8 | 7 |
| **Total** | **61** | **29** | **32** |

### Priority gaps to close

**High priority** (security — hardening was implemented but not tested):
- `Array.prototype` and `Function.prototype` frozen
- `globalThis` sealed (isolated-vm)
- `codemode` non-configurable / non-writable
- Internal state non-enumerable
- `await import()` blocked
- Cross-call isolation for prototype pollution and internal state

**Medium priority** (capability — verified in manual audit, no regression test):
- ES2024 features (`Object.groupBy`, `Array.toSorted`, `Promise.withResolvers`)
- Generators, async generators
- BigInt
- JSON quirks (Infinity/NaN serialization)

**Low priority** (stress/performance — informational):
- Large data allocation
- Max recursion depth
- Complex algorithm benchmarks
