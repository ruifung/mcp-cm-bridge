# isolated-vm Executor - Sandbox Capability Audit

Comprehensive audit of the `isolated-vm` executor's sandbox environment, covering JavaScript
language features, MCP tool integration, performance characteristics, and security boundaries.

**Executor**: `isolated-vm` (auto-detected)
**Timeout**: 30,000ms
**MCP Tools Available**: 191 (across 11 servers)

---

## Test Results Summary

| # | Category                                  | Status |
|---|-------------------------------------------|--------|
| 1 | Basic arithmetic and math operations      | PASS   |
| 2 | String manipulation and regex             | PASS   |
| 3 | Array/Object operations and data structures | PASS |
| 4 | Async/await and Promise patterns          | PASS   |
| 5 | Error handling and edge cases             | PASS   |
| 6 | Complex algorithms                        | PASS   |
| 7 | JSON processing and data transformation  | PASS   |
| 8 | Date/time operations                      | PASS   |
| 9 | Closures, higher-order functions, generators | PASS |
| 10 | Stress test: large data, nested ops, chaining | PASS |
| 11 | MCP tool chaining (memory, time)         | PASS   |
| 12 | Security boundary tests                  | PASS   |

---

## Language Feature Support

### Fully Supported (ES2024)

- `Promise.withResolvers()`
- `Object.groupBy()`
- `Array.toSorted()`, `Array.toReversed()`, `Array.with()`, `Array.findLast()`
- Full async/await, `Promise.all`/`allSettled`/`race`/`any`, async generators, `for await...of`
- BigInt arithmetic
- Proxy and Reflect
- Symbol (including well-known symbols like `Symbol.iterator`)
- Custom iterator protocol
- Generators (sync and async)
- Map, Set, WeakRef, WeakMap
- Full regex: named groups, lookahead/lookbehind, Unicode property escapes
- URI encoding/decoding (`encodeURIComponent`/`decodeURIComponent`)
- Date API
- `JSON.parse`/`JSON.stringify` with replacer/reviver
- Error cause chaining (ES2022)
- Closures, currying, pipe/compose, memoization
- Deep nesting (50+ levels)

### Not Available

| API                  | Status      | Notes                                         |
|----------------------|-------------|-----------------------------------------------|
| `btoa` / `atob`      | Not defined | No Web API base64                             |
| `Buffer`             | Not defined | No Node.js Buffer                             |
| `structuredClone`    | Not defined | No structured cloning                         |
| `setInterval`        | Not defined | Only `setTimeout` is provided                 |
| `fetch`              | Not defined | No network access                             |
| `XMLHttpRequest`     | Not defined | No network access                             |
| `WebSocket`          | Not defined | No network access                             |
| `require()`          | Not defined | No CommonJS module system                     |
| `import()`           | Blocked     | Throws `Error: Not supported`                 |
| `eval()`             | Blocked     | Throws `Error: eval is not allowed`           |
| `process`            | Not defined | No Node.js process object                     |

### Serialization Quirks

- `Infinity` and `NaN` serialize as `null` in JSON responses
- `undefined` values / optional chaining returning `undefined` appear as absent keys
- `eval("if(")` throws generic `Error`, not `SyntaxError` (sandbox restriction)

---

## MCP Tool Integration

The `codemode` global exposes 191 tool functions across 11 MCP servers:

| Server               | Tool Count |
|----------------------|------------|
| code-sandbox         | 7          |
| atlassian_cloud      | 29         |
| swf_gitlab           | 93         |
| sequential-thinking  | 1          |
| memory               | 9          |
| kubernetes           | 23         |
| gcloud               | 1          |
| time                 | 2          |
| gcloud-observability | 13         |
| git                  | 12         |
| microsoft/markitdown | 1          |

### Tool Chaining

- Sequential chaining works: output of one tool feeds into the next
- Parallel execution via `Promise.all` works across different MCP servers
- The `codemode` object is a Proxy; property writes do not persist (monkey-patch protected)

---

## Performance Characteristics

| Benchmark                                                      | Result   |
|----------------------------------------------------------------|----------|
| 100k array sort + 50k Map + tree traversal + 1000 promises    | 241ms    |
| Max recursion depth                                            | ~10,443  |
| Large string allocation (2^25 = 33M chars)                     | Success  |
| Large array allocation (10M elements)                          | Success  |
| Complex algorithms (quicksort, mergesort, DFS, BFS, sieve, matrix multiply, Levenshtein) | All pass |

---

## Security Boundaries

### Blocked (Cannot Escape Sandbox)

| Vector                  | Result                                    |
|-------------------------|-------------------------------------------|
| `require("fs")`         | `ReferenceError: require is not defined`  |
| `await import("fs")`    | `Error: Not supported`                    |
| `eval("...")`           | `Error: eval is not allowed`              |
| `fetch` / `XMLHttpRequest` / `WebSocket` | Not defined              |
| `process` / `process.env` / `process.exit` | Not defined            |
| `setInterval`           | Not defined                               |

### Accessible (By Design)

| API                     | Details                                                   |
|-------------------------|-----------------------------------------------------------|
| `setTimeout`            | Works, returns Promises correctly                         |
| `Function` constructor  | Can execute code strings (`Function("return 1+1")()` = 2) |
| `globalThis`            | Accessible, not frozen, not sealed                        |
| `_hostExecuteTool`      | Native function (arity 2), bridge to MCP tool execution   |
| `_pendingResolvers`     | Internal state object (exposed, typically 0 keys)         |
| `_toolResults`          | Internal state object (exposed, typically 0 keys)         |
| `_toolErrors`           | Internal state object (exposed, typically 0 keys)         |
| `protocol`              | Object with `resolve` and `reject` keys                   |

### Mutability Assessment

| Target                      | Mutable? | Notes                                          |
|-----------------------------|----------|-------------------------------------------------|
| `Object.prototype`          | Yes      | `__proto__` pollution works (cleanup required)  |
| `Array.prototype`           | Yes      | Can add/remove methods                          |
| `globalThis`                | Yes      | Not frozen, not sealed, writable+configurable   |
| `codemode` object           | Protected | Writes appear to succeed but don't persist (Proxy) |
| `codemode` property descriptor | Writable+configurable | Descriptor allows overwrite at globalThis level |

### globalThis Exposed Keys

```
setTimeout, global, _hostExecuteTool, codemode,
_pendingResolvers, _toolResults, _toolErrors, protocol
```

### Cross-Call Isolation

Each `codemode_eval` invocation runs in a **fresh isolate context**. The following mutations
were planted in one call and verified absent in the next:

| Mutation                              | Persists? |
|---------------------------------------|-----------|
| `Object.prototype.__poisoned`         | No        |
| `Array.prototype.evilMethod`          | No        |
| `globalThis.__persistenceTest`        | No        |
| `setTimeout` overwritten with hijack  | No        |
| `Function()` side-effect global       | No        |
| `_pendingResolvers.__tampered`        | No        |
| `_toolResults.__tampered`             | No        |
| `globalThis.__codemodeMarker`         | No        |
| `protocol.__tampered`                 | No        |
| `globalThis.__globalChainTest`        | No        |

**Result**: The `globalThis` keys in the subsequent call were exactly the original 8:
`setTimeout`, `global`, `_hostExecuteTool`, `codemode`, `_pendingResolvers`, `_toolResults`,
`_toolErrors`, `protocol`. Zero leakage across calls.

**Conclusion**: The isolated-vm executor creates a fresh context per execution. All prototype
pollution, global tampering, internal state modification, and `Function` constructor side effects
are fully contained within a single call and do not leak into subsequent invocations.

### Hardening Recommendations

The cross-call isolation means these are **low severity** (intra-call only, no persistence),
but still worth noting for defense-in-depth:

1. **Freeze prototypes** - `Object.freeze(Object.prototype)` and `Array.prototype` to prevent
   prototype pollution within a single execution (e.g., if composing untrusted code fragments
   within one call).
   *Cross-call risk: None - context is fresh each time.*

2. **Seal globalThis** - Prevent new global definitions and make existing properties non-configurable.
   *Cross-call risk: None - context is fresh each time.*

3. **Remove `Function` constructor access** - Currently allows arbitrary code execution strings,
   bypassing the `eval()` block. Mainly a consistency concern since `eval()` is explicitly blocked.
   *Cross-call risk: None - side effects don't persist.*

4. **Make internal state non-enumerable** - `_pendingResolvers`, `_toolResults`, `_toolErrors`
   are visible and writable; could theoretically interfere with tool execution flow within
   a single call.
   *Cross-call risk: None - reset each time.*

5. **Make `codemode` descriptor non-configurable** - While the Proxy protects individual
   tool functions, the entire `codemode` binding could be replaced at the `globalThis` level
   within a single call.
   *Cross-call risk: None - context is fresh each time.*
