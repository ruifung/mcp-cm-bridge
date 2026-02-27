# Sandbox Hardening Report

Status of sandbox hardening measures across all four executor implementations.

**Version**: 1.0.5
**Date**: 2026-02-25

---

## Overview

Five hardening measures were identified in the [isolated-vm sandbox audit](./isolated-vm.md#hardening-recommendations). All applicable measures have been implemented consistently across all four executors.

---

## Hardening Measures

### 1. Freeze Prototypes

Prevent prototype pollution by freezing `Object.prototype`, `Array.prototype`, and `Function.prototype`.

| Executor    | Implemented | Notes |
|-------------|-------------|-------|
| vm2         | Yes | `Object.freeze()` called in hardening script before user code |
| isolated-vm | Yes | `Object.freeze()` called in hardening eval before user code |
| container   | No | OS-level isolation (container boundary); each worker thread is ephemeral. Freezing would break the Node.js runtime environment inside the container. |
| deno        | No | Subprocess isolation; fresh eval context per call. |

### 2. Block `Function` Constructor

Prevent `new Function("code")` as a code execution vector, consistent with the existing `eval` block.

| Executor    | Implemented | Notes |
|-------------|-------------|-------|
| vm2         | Yes | Replaced `globalThis.Function` with a throwing stub in hardening script |
| isolated-vm | Yes | Same approach inside context.eval hardening block |
| container   | Yes | Same approach in worker startup, before user code runs |
| deno        | Yes | Same approach in container-worker.mjs (shared with container) |

### 3. Block `eval`

Prevent `eval()` from being used as a code execution vector.

| Executor    | Implemented | Notes |
|-------------|-------------|-------|
| vm2         | Yes | `eval: false` in VM config + explicit throwing override in sandbox |
| isolated-vm | Yes | `Object.defineProperty` override (non-writable, non-configurable) |
| container   | Yes | Original `eval` saved as `_savedEval` for internal use by `run()`, then `globalThis.eval` overridden with throwing stub |
| deno        | Yes | Same as container (uses shared container-worker.mjs) |

### 4. Non-configurable `codemode`

Prevent the `codemode` object from being overwritten or reconfigured on `globalThis`.

| Executor    | Implemented | Notes |
|-------------|-------------|-------|
| vm2         | Yes | `Object.defineProperty(globalThis, 'codemode', { writable: false, configurable: false })` |
| isolated-vm | Yes | Same. Codemode is mutated in-place (not reassigned) during tool wrapper setup so the binding can be locked down. |
| container   | Yes | Same, applied after proxy creation |
| deno        | Yes | Same, applied after proxy creation |

### 5. Seal `globalThis` / Hide Internals

Prevent adding or removing properties on `globalThis`. Hide internal state from enumeration.

| Executor    | Implemented | Notes |
|-------------|-------------|-------|
| vm2         | No | vm2's `globalThis` is a special proxy that throws on `Object.seal()`. Not needed — vm2 creates a minimal sandbox with only explicitly provided globals. |
| isolated-vm | Yes | `Object.seal(globalThis)` after all setup. Internal state (`_pendingResolvers`, `_toolResults`, `_toolErrors`, `_hostExecuteTool`, `protocol`) made non-enumerable via `Object.defineProperty`. |
| container   | No | Sealing `globalThis` breaks the Node.js worker thread runtime. OS-level container isolation provides the security boundary instead. |
| deno        | No | Same; sealing `globalThis` breaks the runtime. Deno permissions provide the security boundary. |

---

## Test Coverage

The shared test suite (`executor-test-suite.ts`) verifies hardening with these tests:

| Test | What it verifies |
|------|------------------|
| `should not allow eval` | `eval("1+1")` returns an error |
| `should not allow constructor to escape` | `Function("return process")()` returns an error |
| `should block prototype pollution` | `Object.assign(Object.prototype, { polluted: true })` has no effect; `obj.polluted` remains `undefined` |
| `should not allow access to require` | `require("node:fs")` returns an error |
| `should not allow process access` | `process.env` returns an error |
| `should not allow network access` | `fetch`, `require('node:http')` — all blocked |
| `should not allow low-level socket network access` | `net.Socket`, `dgram`, `tls`, `dns` — all blocked |
| `should not allow Deno namespace` | (Deno only) `Deno.readTextFile` — blocked by permissions |

### Per-executor skip list

| Test | vm2 | isolated-vm | container | deno |
|------|-----|-------------|-----------|------|
| `should block prototype pollution` | Runs | Runs | Skipped (no prototype freezing; OS isolation) | Skipped (subprocess boundary) |
| `should not allow eval` | Runs | Runs | Skipped (eval available inside container; OS isolation) | Runs |
| `should not allow constructor to escape` | Runs | Runs | Skipped (Function available inside container; OS isolation) | Runs |
| `should not allow access to require` | Runs | Runs | Skipped (require available inside container; OS isolation) | Runs |
| `should not allow process access` | Runs | Runs | Skipped (process available inside container; OS isolation) | Runs |
| `should isolate data between concurrent executions` | Runs | Skipped (`Object.seal(globalThis)` prevents adding new globals) | Skipped (serialized execution) | Skipped (serialized execution) |

---

## Security Model Summary

| Layer | vm2 | isolated-vm | container | deno |
|-------|-----|-------------|-----------|------|
| Isolation level | JS-level (vm2 sandbox) | V8 isolate (separate heap) | OS-level (container boundary) | Subprocess (deno permissions) |
| Prototype freeze | Yes | Yes | No (not needed) | No (subprocess boundary) |
| eval blocked | Yes | Yes | Yes | Yes (hardening script) |
| Function constructor blocked | Yes | Yes | Yes | Yes (hardening script) |
| codemode non-configurable | Yes | Yes | Yes | Yes |
| globalThis sealed | No (proxy limitation) | Yes | No (breaks runtime) | No (breaks runtime) |
| Internals hidden | N/A (no internal state) | Yes (non-enumerable) | N/A (no internal state on globalThis) | N/A |
| Network blocked | No require/fetch available | No network APIs available | `--network=none` at container level | `--deny-net` at subprocess level |
| Fresh context per call | Yes (new VM) | Yes (new context) | Yes (new worker thread) | Yes (fresh eval context) |

---

## Files Modified

- `src/executor/vm2-executor.ts` — Hardening block after VM creation
- `src/executor/isolated-vm-executor.ts` — Refactored codemode setup (mutate in-place), hardening block after protocol setup
- `src/executor/container-worker.mjs` — Hardening section in worker startup, `_savedEval` pattern for `run()`
- `src/executor/deno-executor.ts` — Implements subprocess isolation with strict permissions
- `src/executor/executor-test-suite.ts` — `should block prototype pollution` test (replaces old isolation test)
- `src/executor/executor-runner.test.ts` — Updated skip lists
