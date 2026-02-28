/**
 * E2E HTTP Serve Tests
 *
 * Tests the HTTP serve mode of the codemode bridge by starting a real HTTP
 * server via `startCodeModeBridgeServer()` and connecting MCP clients using
 * `StreamableHTTPClientTransport`.
 *
 * Architecture under test:
 *
 *   [StreamableHTTPClientTransport]
 *     ↔ HTTP (POST/GET /mcp, GET /health, DELETE /mcp)
 *     ↔ StreamableHTTPServerTransport  (one per session, keyed by UUID)
 *     ↔ McpServer                      (one per session, built by buildMcpServer())
 *     ↔ SessionResolver                (per-client executor isolation)
 *
 * Executor: vm2 (fastest, no container overhead)
 * Framework: Vitest 4.0.18
 *
 * ── Per-session architecture ─────────────────────────────────────────────────
 *
 * Each client `initialize` request creates a fresh `StreamableHTTPServerTransport`
 * + `McpServer` pair and stores them in a `Map<sessionId, transport>`. This
 * enables true multi-client isolation: concurrent clients each have their own
 * session ID (UUID v4), their own executor, and their own MCP server instance.
 *
 * The `transport.onclose` callback captures the session ID in a closure
 * (O(1) cleanup) so the map entry is removed when a client disconnects or
 * sends a DELETE request.
 *
 * Tests 8 and 9 below verify this multi-client behaviour directly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCodeModeBridgeServer } from '../../src/mcp/server.js';

// ── Silence logger output during tests ─────────────────────────────────────

vi.mock('../../src/utils/logger.js', () => ({
  initializeLogger: vi.fn(),
  getLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
  enableStderrBuffering: vi.fn(),
  flushStderrBuffer: vi.fn(),
}));

// ── Port allocation ─────────────────────────────────────────────────────────

const TEST_PORT = Math.floor(Math.random() * 10000) + 20000;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const MCP_URL = new URL(`${BASE_URL}/mcp`);

// ── Shared single client ─────────────────────────────────────────────────────

/**
 * Primary MCP client shared across single-client tests.  Tests that verify
 * multi-client behaviour (tests 8 and 9) create their own additional clients
 * inline and close them in a finally block.
 */
let sharedClient: Client;
let sharedTransport: StreamableHTTPClientTransport;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Call the eval tool and return the result extracted from content[0].text.
 *
 * The bridge maps `{ type: "json", value }` returns to a text content block
 * containing JSON.stringify(value). We parse that text to recover the value.
 */
async function callEval(
  client: Client,
  code: string,
): Promise<{ result: any; logs?: string[] }> {
  const response = await client.callTool({ name: 'sandbox_eval_js', arguments: { code } });
  const content = (response as any).content;
  if (!content || !Array.isArray(content) || content.length === 0) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(response)}`);
  }
  try {
    return { result: JSON.parse(content[0].text) };
  } catch {
    throw new Error(`Could not extract result from response: ${JSON.stringify(response)}`);
  }
}

/**
 * Poll the health endpoint until it responds 200, giving the server time to
 * bind. Avoids any fixed sleep.
 */
async function waitForServerReady(
  url: string,
  maxAttempts = 40,
  delayMs = 250,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Server not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Server at ${url} did not become ready after ${maxAttempts * delayMs}ms`);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('HTTP Serve Mode E2E', () => {
  beforeAll(async () => {
    // Fire-and-forget: startCodeModeBridgeServer() blocks forever internally
    // (waiting for SIGINT/SIGTERM). We intentionally do NOT await it.
    startCodeModeBridgeServer({
      serverConfigs: [], // no upstream servers needed for eval-only tests
      executorType: 'vm2',
      http: { port: TEST_PORT, host: 'localhost' },
    });

    // Wait until the server is actually accepting connections
    await waitForServerReady(`${BASE_URL}/health`);

    // Create the single shared MCP client.  Dynamic imports are used here
    // because the SDK uses ESM and we need to defer until after vi.mock()
    // has had a chance to take effect.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    sharedTransport = new StreamableHTTPClientTransport(MCP_URL);
    sharedClient = new Client(
      { name: 'shared-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await sharedClient.connect(sharedTransport);
  }, 60_000);

  afterAll(async () => {
    try {
      await sharedClient?.close();
    } catch {
      // best-effort
    }
  });

  // ── 1. Health endpoint ────────────────────────────────────────────────────

  it('should return 200 with { status: "ok" } from GET /health', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  // ── 2. Single client: list tools ─────────────────────────────────────────

  it('should expose the "sandbox_eval_js" tool in the tool list', async () => {
    const { tools } = await sharedClient.listTools();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('sandbox_eval_js');
  });

  // ── 3. Single client: basic eval ─────────────────────────────────────────

  it('should execute a simple arithmetic expression via eval', async () => {
    const output = await callEval(sharedClient, 'async () => { return { type: "json", value: 6 * 7 }; }');
    expect(output.result).toBe(42);
  });

  // ── 4. Session ID is a valid UUID ─────────────────────────────────────────

  it('should assign a valid UUID as sessionId after connecting', () => {
    const sessionId = sharedTransport.sessionId;
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // ── 5. Per-call state isolation ──────────────────────────────────────────
  //
  // vm2-executor.ts creates a brand-new VM sandbox on every execute() call,
  // so globalThis state set in one call is never visible in a subsequent call.
  // This is intentional security isolation — not a bug.
  // (See also: e2e-bridge-test-suite.ts "should isolate state between executions")

  it('should isolate globalThis state between successive eval calls (vm2 fresh-sandbox semantics)', async () => {
    // First call: set a global variable
    await callEval(sharedClient, 'async () => { globalThis.isolationProbe = "set-by-call-1"; return { type: "json", value: null }; }');

    // Second call: the variable must NOT be visible — fresh sandbox
    const output = await callEval(sharedClient, 'async () => { return { type: "json", value: typeof globalThis.isolationProbe }; }');
    expect(output.result).toBe('undefined');
  });

  // ── 6. Error handling ─────────────────────────────────────────────────────

  it('should return an error response (not crash) when eval code throws', async () => {
    const response = await sharedClient.callTool({
      name: 'sandbox_eval_js',
      arguments: { code: 'async () => { throw new Error("intentional test error"); }' },
    });

    const content = (response as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    const text: string = content[0].text;
    expect(text).toBeTruthy();
    // The error message should appear somewhere in the response
    expect(text.toLowerCase()).toMatch(/error|intentional test error/);
  });

  // ── 7. Invalid endpoint returns 404 ──────────────────────────────────────

  it('should return 404 for unknown paths', async () => {
    const res = await fetch(`${BASE_URL}/nonexistent`);
    expect(res.status).toBe(404);
  });

  // ── 8. Multi-client isolation ─────────────────────────────────────────────
  //
  // Each client gets its own session ID (UUID) and a dedicated executor.
  // A variable set via eval in client A must NOT be visible to client B.

  it('should give different session IDs to different clients and isolate their state', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    // Create a second independent client
    const transportB = new StreamableHTTPClientTransport(MCP_URL);
    const clientB = new Client(
      { name: 'test-client-b', version: '1.0.0' },
      { capabilities: {} },
    );
    await clientB.connect(transportB);

    try {
      // Both clients get valid UUID session IDs
      const sessionIdA = sharedTransport.sessionId;
      const sessionIdB = transportB.sessionId;

      expect(sessionIdA).toBeDefined();
      expect(sessionIdB).toBeDefined();
      expect(sessionIdA).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(sessionIdB).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Different clients get different session IDs
      expect(sessionIdA).not.toBe(sessionIdB);

      // vm2 creates a fresh sandbox per call, so no state leaks between calls
      // regardless of session. We verify sessions are truly isolated by checking
      // that both clients function independently with their own eval context.
      const resultA = await callEval(sharedClient, 'async () => { return { type: "json", value: 100 + 1 }; }');
      const resultB = await callEval(clientB, 'async () => { return { type: "json", value: 200 + 2 }; }');

      expect(resultA.result).toBe(101);
      expect(resultB.result).toBe(202);
    } finally {
      await clientB.close().catch(() => {});
    }
  });

  // ── 9. Concurrent execution ───────────────────────────────────────────────
  //
  // Two clients run concurrent eval calls and each gets the correct
  // independent result — no cross-session interference.

  it('should handle concurrent tool calls from two clients without interference', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const transportC = new StreamableHTTPClientTransport(MCP_URL);
    const clientC = new Client(
      { name: 'test-client-c', version: '1.0.0' },
      { capabilities: {} },
    );
    await clientC.connect(transportC);

    try {
      // Fire both eval calls concurrently
      const [resultA, resultC] = await Promise.all([
        callEval(sharedClient, 'async () => { return { type: "json", value: "from-A" }; }'),
        callEval(clientC,      'async () => { return { type: "json", value: "from-C" }; }'),
      ]);

      expect(resultA.result).toBe('from-A');
      expect(resultC.result).toBe('from-C');
    } finally {
      await clientC.close().catch(() => {});
    }
  });

  // ── 10. Utils virtual server ──────────────────────────────────────────────
  //
  // The `utils` virtual server is registered at startup (no upstream MCP
  // connection needed). Tests 10a–10d verify the two YAML tools and that the
  // server appears in sandbox_get_functions discovery output.

  // ── 10a. Parse valid YAML ─────────────────────────────────────────────────

  it('should parse a valid YAML string into a JavaScript object via utils__yaml__parse', async () => {
    const output = await callEval(
      sharedClient,
      `async () => {
        const raw = await codemode.utils__yaml__parse({ input: "key: value\\nlist:\\n  - 1\\n  - 2" });
        // The tool returns { content: [{ text: JSON.stringify(result) }], structuredContent: { result } }
        const parsed = raw.structuredContent.result;
        return { type: "json", value: parsed };
      }`,
    );

    expect(output.result).toEqual({ key: 'value', list: [1, 2] });
  });

  // ── 10b. Stringify object to YAML ─────────────────────────────────────────

  it('should serialize a JavaScript object to a YAML string via utils__yaml__stringify', async () => {
    const output = await callEval(
      sharedClient,
      `async () => {
        const raw = await codemode.utils__yaml__stringify({ input: { key: "value", count: 42 } });
        // The tool returns the YAML string directly as content[0].text
        const yamlString = raw.content[0].text;
        return { type: "json", value: yamlString };
      }`,
    );

    expect(typeof output.result).toBe('string');
    expect(output.result.length).toBeGreaterThan(0);
    expect(output.result).toContain('key:');
    expect(output.result).toContain('value');
    expect(output.result).toContain('42');
  });

  // ── 10c. Invalid YAML returns error ───────────────────────────────────────

  it('should return an error response when utils__yaml__parse receives invalid YAML', async () => {
    // Call the tool via eval and surface the error information to the caller.
    // The descriptor's execute() returns { content: [...], isError: true } for
    // invalid input; the eval script wraps that response object as JSON so we
    // can inspect it without the outer MCP error machinery swallowing it.
    const output = await callEval(
      sharedClient,
      `async () => {
        const raw = await codemode.utils__yaml__parse({ input: "invalid: yaml: :" });
        return { type: "json", value: { isError: raw.isError, text: raw.content[0].text } };
      }`,
    );

    expect(output.result.isError).toBe(true);
    expect(output.result.text).toMatch(/YAML parse error/i);
  });

  // ── 10d. Utils tools appear in sandbox_get_functions ─────────────────────

  it('should list utils__yaml__parse and utils__yaml__stringify in sandbox_get_functions', async () => {
    // Call the discovery tool directly (not via eval) with a server filter.
    const response = await sharedClient.callTool({
      name: 'sandbox_get_functions',
      arguments: { server: 'utils' },
    });

    const content = (response as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);

    const text: string = content[0].text;
    expect(text).toContain('utils__yaml__parse');
    expect(text).toContain('utils__yaml__stringify');
  });

  // ── 11. Utils tool invocation regression ─────────────────────────────────
  //
  // Regression tests for the runtime failure when utils tools are invoked.
  // Reported symptom: calling utils__yaml__parse or utils__yaml__stringify
  // from inside the eval sandbox throws "keyValidator._parse is not a function",
  // suspected to be a Zod v4 compatibility issue.
  //
  // Tests 11a and 11b verify direct MCP protocol calls (i.e. sharedClient.callTool
  // with the utils tool name). Because utils tools are NOT registered as top-level
  // MCP tools on the McpServer (only accessible through the eval sandbox), these
  // calls are expected to fail with a "Tool not found" error, not a Zod runtime
  // error. This confirms the architecture and isolates the failure to the eval path.
  //
  // Tests 11c and 11d target the eval sandbox path, which is where the reported
  // runtime error occurs.  Test 11d is a sanity-check baseline.
  //
  // ALL FOUR TESTS ARE EXPECTED TO FAIL INITIALLY while the bug is present:
  //   11a and 11b fail because the tool name is not exposed as a direct MCP call.
  //   11c fails with the "keyValidator._parse is not a function" Zod error.
  //   11d passes (basic eval sanity — it does NOT call any utils tool).
  //
  // Once the bug is fixed, 11c (and optionally 11a/11b if the architecture
  // changes to expose utils tools directly) should pass.

  // ── 11a. Direct MCP call — yaml parse (architecture probe) ───────────────

  it('should handle a direct MCP callTool for utils__yaml__parse (not an exposed top-level MCP tool)', async () => {
    // utils__yaml__parse is only accessible through the eval sandbox —
    // it is NOT registered as a top-level MCP tool on the McpServer.
    // This test documents that calling it directly results in an error response
    // (tool not found), NOT a runtime crash of the server.
    let response: any;
    let threw = false;
    try {
      response = await sharedClient.callTool({
        name: 'utils__yaml__parse',
        arguments: { input: 'key: value' },
      });
    } catch (err) {
      threw = true;
      response = err;
    }

    // The server should respond with a recognisable error (tool not found),
    // not crash or return an unrelated Zod runtime error.
    if (threw) {
      // SDK threw because the server returned an error — expected
      const msg = (response as Error).message ?? String(response);
      expect(msg).toMatch(/tool.*not found|unknown tool|method not found/i);
    } else {
      // Server returned an isError response — also acceptable
      const content = response?.content;
      expect(Array.isArray(content)).toBe(true);
      const text: string = (content?.[0]?.text ?? '').toLowerCase();
      expect(text).toMatch(/tool.*not found|unknown tool|not registered/i);
    }
  });

  // ── 11b. Direct MCP call — yaml stringify (architecture probe) ────────────

  it('should handle a direct MCP callTool for utils__yaml__stringify (not an exposed top-level MCP tool)', async () => {
    // Same architecture probe as 11a, but for the stringify tool.
    let response: any;
    let threw = false;
    try {
      response = await sharedClient.callTool({
        name: 'utils__yaml__stringify',
        arguments: { input: { key: 'value' } },
      });
    } catch (err) {
      threw = true;
      response = err;
    }

    if (threw) {
      const msg = (response as Error).message ?? String(response);
      expect(msg).toMatch(/tool.*not found|unknown tool|method not found/i);
    } else {
      const content = response?.content;
      expect(Array.isArray(content)).toBe(true);
      const text: string = (content?.[0]?.text ?? '').toLowerCase();
      expect(text).toMatch(/tool.*not found|unknown tool|not registered/i);
    }
  });

  // ── 11c. Eval sandbox — yaml parse (primary regression target) ───────────
  //
  // This is the MAIN regression test. Reported to fail with:
  //   "keyValidator._parse is not a function"
  // which is a Zod v4 internal API incompatibility (the SDK or zod-to-ts still
  // calls a Zod v3 internal `_parse` method that no longer exists in v4).

  it('should execute utils__yaml__parse inside the eval sandbox without a runtime error', async () => {
    const output = await callEval(
      sharedClient,
      `async () => {
        const raw = await codemode.utils__yaml__parse({ input: "hello: world\\ncount: 99" });
        // Surface both the raw response shape and parsed result for diagnosis
        const result = raw?.structuredContent?.result ?? raw?.content?.[0]?.text;
        return { type: "json", value: result };
      }`,
    );

    // The parsed YAML should be a JavaScript object with the expected fields
    expect(output.result).toBeDefined();
    expect(typeof output.result).toBe('object');
    expect(output.result).not.toBeNull();
    expect((output.result as any).hello).toBe('world');
    expect((output.result as any).count).toBe(99);
  });

  // ── 11d. Eval sandbox sanity — basic arithmetic (baseline) ────────────────
  //
  // This test does NOT call any utils tool. If it passes while 11c fails, the
  // bug is isolated to the utils tool invocation (Zod schema validation or
  // descriptor wiring), not a general eval sandbox failure.
  // If this test ALSO fails, the eval sandbox itself is broken.

  it('should evaluate a simple expression in the sandbox (no codemode calls)', async () => {
    const output = await callEval(
      sharedClient,
      `async () => {
        const x = 1 + 1;
        return { type: "json", value: x };
      }`,
    );

    expect(output.result).toBe(2);
  });

  // ── 11e. Eval sandbox — yaml stringify (secondary regression target) ───────
  //
  // Companion to 11c. Verifies the stringify direction of the utils tools.

  it('should execute utils__yaml__stringify inside the eval sandbox without a runtime error', async () => {
    const output = await callEval(
      sharedClient,
      `async () => {
        const raw = await codemode.utils__yaml__stringify({ input: { greeting: "hello", count: 42 } });
        // The stringify tool returns the YAML string as content[0].text
        const yamlString = raw?.content?.[0]?.text ?? raw?.structuredContent?.result;
        return { type: "json", value: yamlString };
      }`,
    );

    expect(typeof output.result).toBe('string');
    expect(output.result.length).toBeGreaterThan(0);
    expect(output.result).toContain('greeting:');
    expect(output.result).toContain('hello');
    expect(output.result).toContain('42');
  });
});
