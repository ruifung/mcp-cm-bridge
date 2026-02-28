# HITL Tool Verification — Preliminary Plan

## Objective

Add Human-in-the-Loop (HITL) verification to codemode-bridge so that tool calls from potentially untrusted LLM-generated code can be gated behind user-configurable policies (allowlist, denylist, asklist) and user confirmation prompts.

## Features

### Feature 1: Profile-based eval tool variants (`codemode_eval_<profile>`)

Each named profile in `evaluation.profiles` gets its own MCP tool registered as `codemode_eval_<name>`. The LLM (or the human, via client-side tool filtering) selects which profile to invoke. The profile is bound at registration — the LLM cannot change or override it.

The base `eval` tool remains unrestricted when no `defaultProfile` is configured (fully backward compatible).

**Config schema:**
```json
{
  "servers": { "..." },
  "evaluation": {
    "profiles": {
      "safe": {
        "allowlist": ["time__*", "search_tools", "get_tools"]
      },
      "supervised": {
        "denylist": ["filesystem__delete_*"],
        "asklist": ["filesystem__*", "swf_gitlab__*"],
        "elicitationFallback": "deny"
      }
    }
  }
}
```

**Precedence:** `denylist` > `asklist` > `allowlist` > default allow

**Profile name constraints:** alphanumeric + underscores only, max 32 chars — validated at startup.

---

### Feature 2: Static analysis (acorn) — elicitation preview

Before sandbox execution, the code is walked with `acorn-walk` to extract likely `codemode.toolName(...)` call sites. This list is surfaced in the elicitation prompt as context for the user — **not used for enforcement**.

**What it catches:**
```js
codemode.delete_file({ path: "..." })         // ✅ detected
codemode["delete_file"]({ path: "..." })      // ✅ detected (string literal computed)
const fn = codemode.delete_file; fn(...)      // ❌ missed (aliased)
codemode[varName](...)                        // ❌ missed (dynamic)
```

**No early-throw on static analysis** — removed from design to avoid false positives on dynamic call patterns. Runtime enforcement is the sole gate.

---

### Feature 3: Runtime enforcement (`applyProfile`)

The `fns` object is wrapped before being passed to the executor. Policy is resolved **live per invocation** against the current tool list (not pre-resolved at startup), so it stays current as servers connect/disconnect dynamically.

**Disposition resolution (per tool, per call):**
1. Matches `denylist`? → deny (throw `ToolCallDeniedError` immediately)
2. Matches `asklist`? → ask (trigger elicitation prompt)
3. `allowlist` present and not matching? → deny
4. Otherwise → allow (pass through)

Defense in depth: even if static analysis misses a dynamic call, the runtime wrapper catches it when the tool is actually invoked.

---

### Feature 4: User confirmation via `elicitation/create`

When an asklist tool is invoked at runtime, the server calls `Server.elicitInput()` on the per-session MCP client connection.

**Prompt format includes:**
- Tool name + argument summary
- Static analysis preview of other tool calls detected in the script

**Future v2:** Use `sampling/createMessage` to LLM-summarize long/complex argument payloads.

**Elicitation result handling:**
- `accept` → proceed with tool call
- `decline` / `cancel` → throw `ToolCallDeniedError`

**Fallback (client doesn't support elicitation):**
- `elicitationFallback: "deny"` (default) → treat asklist tools as denylist
- `elicitationFallback: "allow"` → pass through without confirmation

**Per-session correctness:** In HTTP multi-session mode, elicitation uses the per-session `Server` instance — not a global reference.

---

## Architecture

### Core Types (`src/mcp/eval-profile-types.ts`)

```typescript
interface EvalProfileConfig {
  allowlist?: string[]           // glob patterns — only matching tools allowed
  denylist?: string[]            // glob patterns — always blocked (highest priority)
  asklist?: string[]             // glob patterns — require user confirmation
  elicitationFallback?: "deny" | "allow"  // if client lacks elicitation support
}

interface EvaluationConfig {
  defaultProfile?: string        // profile name to apply to the base `eval` tool
  profiles?: Record<string, EvalProfileConfig>
}

enum ToolDisposition { Allow = "allow", Deny = "deny", Ask = "ask" }
```

### `applyProfile()` (`src/mcp/apply-profile.ts`)

```typescript
function applyProfile(
  fns: Record<string, ToolFn>,
  profileConfig: EvalProfileConfig,
  elicitation: ElicitationProvider
): Record<string, ToolFn>

interface ElicitationProvider {
  isElicitationSupported(): boolean
  elicitApproval(toolName: string, args: unknown): Promise<boolean>
}

class ToolCallDeniedError extends Error {
  readonly toolName: string
  readonly reason: "denied" | "elicitation_declined" | "elicitation_unsupported"
}
```

### `extractToolCalls()` (`src/mcp/static-analysis.ts`)

```typescript
interface ExtractedToolCall {
  toolName: string   // property name from codemode.X
  line: number
  column: number
}

function extractToolCalls(code: string): ExtractedToolCall[]
// Uses acorn + acorn-walk. Returns [] on parse error. UX-only, not enforcement.
```

### Integration point in `makeProfileEvalHandler`

```
get live fns from serverManager.getAllToolDescriptors()
wrappedFns = applyProfile(fns, profileConfig, createElicitationProvider(sessionServer))
staticCalls = extractToolCalls(normalizedCode)   // for elicitation context only
executor.execute(normalizedCode, wrappedFns)
```

---

## Files

| File | Action | Purpose |
|---|---|---|
| `src/mcp/eval-profile-types.ts` | CREATE | Types + `getDisposition()` |
| `src/mcp/apply-profile.ts` | CREATE | `applyProfile()`, `ElicitationProvider`, `createElicitationProvider()`, `ToolCallDeniedError` |
| `src/mcp/static-analysis.ts` | CREATE | `extractToolCalls()` — acorn-walk, UX context only |
| `src/mcp/profile-registration.ts` | CREATE | `registerProfileTools()`, `rebuildProfileTools()`, `SessionHandles` type |
| `src/mcp/config.ts` | MODIFY | Add `evaluation?: EvaluationConfig` to `MCPJsonConfig` |
| `src/mcp/server.ts` | MODIFY | Profile registration at startup; per-session Server ref threading; `makeProfileEvalHandler()` |
| `src/mcp/config-watcher.ts` | MODIFY | Detect `evaluation` section changes, trigger `rebuildProfileTools()` |
| `package.json` | MODIFY | Add `picomatch`, `acorn-walk` |

---

## Implementation Phases

```
Phase 1 — Foundation (all parallelizable)
  ├── eval-profile-types.ts  (types + getDisposition)
  ├── apply-profile.ts       (applyProfile + ElicitationProvider)
  ├── config.ts              (schema extension)
  └── package.json           (add picomatch, acorn-walk)

Phase 2 — Analysis module (standalone)
  └── static-analysis.ts    (extractToolCalls)

Phase 3 — Registration layer
  └── profile-registration.ts  (depends on Phase 1)

Phase 4 — Integration
  └── server.ts              (threads everything — depends on Phases 1–3)

Phase 5 — Hot-reload
  └── config-watcher.ts      (depends on Phase 4)

Phase 6 — Tests (can start alongside Phase 1)
  ├── applyProfile unit tests (mock ElicitationProvider)
  ├── getDisposition unit tests (glob precedence cases)
  ├── extractToolCalls unit tests (AST detection cases)
  └── integration test (elicitation mock + sandbox execution)
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Runtime enforcement only (no static gate) | Static analysis is trivially bypassed via aliasing/dynamic access. Runtime wrapper on `fns` is the only sound enforcement boundary. |
| Live resolution per invocation (not pre-resolved at startup) | MCP tool topology is dynamic. Pre-resolving against a snapshot creates stale deny/ask/allow sets. |
| Profile-as-separate-tool | LLM cannot select a more permissive profile. Human configures profiles; LLM only sees the tools the harness exposes. |
| Base `eval` unrestricted when no `defaultProfile` | Backward compatibility. No behaviour change unless user explicitly configures profiles. |
| `elicitationFallback: "deny"` default | Secure by default. If the client harness doesn't support elicitation, asklist tools are blocked, not silently allowed. |
| No early-throw on static analysis | Avoids false positives where dynamic/aliased tool calls would block legitimate execution. |
| Per-session `Server` ref for elicitation | In HTTP multi-session mode, each session has its own `Server`. Using a global ref would elicit from the wrong user. |

---

## Out of Scope (v1)

- Batch elicitation (one prompt for all asklist calls in an eval, not one per call)
- Per-argument-value approval (e.g., approve `delete_file` but not for `/etc/passwd`)
- `sampling/createMessage` for summarizing long args (v2 enhancement, noted above)
- Audit log of approved/denied calls
- Elicitation rate limiting / prompt flood protection
- Profile inheritance
- Per-session profile override

---

*Plan generated: 2026-02-28*
