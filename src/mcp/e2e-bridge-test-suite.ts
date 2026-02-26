/**
 * E2E Bridge Test Suite Factory
 *
 * Reusable test suite that verifies the full codemode bridge pipeline
 * against any Executor implementation:
 *
 *   [Downstream MCP Client]
 *     ↔ InMemoryTransport
 *     ↔ [McpServer with codemode tool]
 *     ↔ Executor (parameterized)
 *     ↔ [Mock upstream MCP tools]
 *
 * Usage:
 * ```typescript
 * import { createE2EBridgeTestSuite } from './e2e-bridge-test-suite.js';
 * import { createVM2Executor } from '../executor/vm2-executor.js';
 *
 * createE2EBridgeTestSuite('vm2', () => new VM2Executor(10000));
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { z } from 'zod';
import type { Executor } from '@cloudflare/codemode';
import { adaptAISDKToolToMCP } from './mcp-adapter.js';
import { jsonSchemaToZod } from './server.js';
import { getRuntimeName } from '../utils/env.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a mock upstream MCP server with test tools and connect an MCP client
 * to it via InMemoryTransport.
 */
async function createMockUpstreamServer() {
  const upstream = new McpServer({ name: 'test-upstream', version: '1.0.0' });

  upstream.registerTool(
    'add',
    {
      description: 'Add two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
    },
    async ({ a, b }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(a + b) }],
    }),
  );

  upstream.registerTool(
    'echo',
    {
      description: 'Echo back the input text',
      inputSchema: z.object({ text: z.string() }).strict(),
    },
    async ({ text }) => ({
      content: [{ type: 'text' as const, text }],
    }),
  );

  upstream.registerTool(
    'get_user',
    {
      description: 'Get user by ID',
      inputSchema: z.object({ id: z.number() }).strict(),
    },
    async ({ id }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ id, name: `User ${id}`, email: `user${id}@test.com` }),
        },
      ],
    }),
  );

  upstream.registerTool(
    'fail',
    {
      description: 'A tool that always fails',
      inputSchema: z.object({ message: z.string().optional() }).strict(),
    },
    async ({ message }) => {
      throw new Error(message ?? 'Intentional failure');
    },
  );

  upstream.registerTool(
    'multiply',
    {
      description: 'Multiply two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
    },
    async ({ a, b }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(a * b) }],
    }),
  );

  upstream.registerTool(
    'list_items',
    {
      description: 'Return a list of items',
      inputSchema: z.object({ count: z.number() }).strict(),
    },
    async ({ count }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
          ),
        },
      ],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const upstreamClient = new Client(
    { name: 'bridge-test-client', version: '1.0.0' },
    { capabilities: {} },
  );

  await upstream.connect(serverTransport);
  await upstreamClient.connect(clientTransport);

  return { upstream, upstreamClient, clientTransport, serverTransport };
}

/**
 * Create the full codemode bridge pipeline with a given executor and return a
 * downstream MCP client that can call the codemode tool.
 */
async function createBridgePipeline(upstreamClient: Client, serverName: string, executor: Executor) {
  // 1. List tools from upstream (native MCP format)
  const { tools: upstreamTools } = await upstreamClient.listTools();

  // 2. Convert to ToolDescriptor format with execute functions
  const toolDescriptors: Record<string, any> = {};
  for (const tool of upstreamTools) {
    const namespacedName = `${serverName}__${tool.name}`;
    toolDescriptors[namespacedName] = {
      description: tool.description || '',
      inputSchema: jsonSchemaToZod(tool.inputSchema),
      execute: async (args: any) => {
        const result = await upstreamClient.callTool({ name: tool.name, arguments: args });
        return result;
      },
    };
  }

  // 3. Create the codemode tool via SDK
  const codemodeTool = createCodeTool({ tools: toolDescriptors, executor });

  // 4. Create bridge MCP server and register codemode tool
  const bridgeServer = new McpServer({ name: 'codemode-bridge-test', version: '1.0.0' });
  await adaptAISDKToolToMCP(bridgeServer, codemodeTool);

  // 5. Wire up downstream client via InMemoryTransport
  const [downstreamClientTransport, downstreamServerTransport] = InMemoryTransport.createLinkedPair();

  const downstreamClient = new Client(
    { name: 'test-consumer', version: '1.0.0' },
    { capabilities: {} },
  );

  await bridgeServer.connect(downstreamServerTransport);
  await downstreamClient.connect(downstreamClientTransport);

  return { bridgeServer, downstreamClient, downstreamClientTransport, downstreamServerTransport, _executor: executor };
}

/**
 * Helper: call the codemode tool and parse the result
 */
async function callCodemode(
  client: Client,
  code: string,
): Promise<{ code: string; result: any; logs?: string[] }> {
  const response = await client.callTool({ name: 'eval', arguments: { code } });

  const content = (response as any).content;
  if (!content || !Array.isArray(content) || content.length === 0) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(response)}`);
  }

  const text = content[0].text;
  return JSON.parse(text);
}

// ── Test Suite Factory ──────────────────────────────────────────────────────

export interface E2EBridgeTestSuiteOptions {
  /** Test names to skip (exact match against it() description) */
  skipTests?: string[];
  /** Per-test timeout in ms (default: vitest default) */
  testTimeout?: number;
}

export function createE2EBridgeTestSuite(
  executorName: string,
  createExecutor: () => Executor,
  options?: E2EBridgeTestSuiteOptions,
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

  describe(`E2E Bridge Pipeline [${executorName}]`, () => {
    console.log(`[Test] Runtime: ${getRuntimeName()}`);
    let upstreamState: Awaited<ReturnType<typeof createMockUpstreamServer>>;
    let bridgeState: Awaited<ReturnType<typeof createBridgePipeline>>;
    let client: Client;

    beforeAll(async () => {
      upstreamState = await createMockUpstreamServer();
      const executor = createExecutor();
      // If executor has a lazy init (e.g. container), trigger it now so the
      // startup cost is not counted against the first test's timeout.
      if ('init' in executor && typeof (executor as any).init === 'function') {
        await (executor as any).init();
      }
      bridgeState = await createBridgePipeline(upstreamState.upstreamClient, 'test', executor);
      client = bridgeState.downstreamClient;
    }, options?.testTimeout ? options.testTimeout * 2 : undefined);

    afterAll(async () => {
      if (!bridgeState) return;
      await bridgeState.downstreamClient.close();
      await bridgeState.bridgeServer.close();
      if (upstreamState) {
        await upstreamState.upstreamClient.close();
        await upstreamState.upstream.close();
      }
      // Cleanup executor if it has a dispose method
      const executor = (bridgeState as any)._executor;
      if (executor && 'dispose' in executor && typeof executor.dispose === 'function') {
        await Promise.resolve(executor.dispose());
      }
    });

    // ── Tool Discovery ──────────────────────────────────────────────────

    describe('Tool Discovery', () => {
      testOrSkip('should expose a single codemode tool', async () => {
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('eval');
      });

      testOrSkip('should have code input schema', async () => {
        const { tools } = await client.listTools();
        const codemodeTool = tools[0];
        expect(codemodeTool.inputSchema).toBeDefined();
        expect(codemodeTool.inputSchema.properties).toHaveProperty('code');
      });

      testOrSkip('should include tool descriptions from upstream', async () => {
        const { tools } = await client.listTools();
        const description = tools[0].description || '';
        expect(description).toContain('test__add');
        expect(description).toContain('test__echo');
      });
    });

    // ── Simple Code Execution ───────────────────────────────────────────

    describe('Simple Code Execution', () => {
      testOrSkip('should execute arithmetic and return result', async () => {
        const output = await callCodemode(client, 'async () => { return 1 + 2; }');
        expect(output.result).toBe(3);
      });

      testOrSkip('should execute string operations', async () => {
        const output = await callCodemode(client, 'async () => { return "hello" + " " + "world"; }');
        expect(output.result).toBe('hello world');
      });

      testOrSkip('should execute object construction', async () => {
        const output = await callCodemode(client, 'async () => { return { a: 1, b: [2, 3] }; }');
        expect(output.result).toEqual({ a: 1, b: [2, 3] });
      });

      testOrSkip('should handle async/await code', async () => {
        const output = await callCodemode(
          client,
          'async () => { const p = Promise.resolve(42); return await p; }',
        );
        expect(output.result).toBe(42);
      });

      testOrSkip('should echo back the original code', async () => {
        const code = 'async () => { return 99; }';
        const output = await callCodemode(client, code);
        expect(output.code).toBe(code);
      });
    });

    // ── Tool Invocation Through Bridge ──────────────────────────────────

    describe('Tool Invocation', () => {
      testOrSkip('should call upstream add tool and return result', async () => {
        const output = await callCodemode(
          client,
          'async () => { const r = await codemode.test__add({ a: 5, b: 3 }); return r; }',
        );
        expect(output.result).toBeDefined();
        const content = output.result?.content?.[0]?.text;
        expect(content).toBeDefined();
        expect(JSON.parse(content)).toBe(8);
      });

      testOrSkip('should call upstream echo tool', async () => {
        const output = await callCodemode(
          client,
          'async () => { const r = await codemode.test__echo({ text: "hello bridge" }); return r; }',
        );
        const content = output.result?.content?.[0]?.text;
        expect(content).toBe('hello bridge');
      });

      testOrSkip('should call upstream get_user tool with structured response', async () => {
        const output = await callCodemode(
          client,
          'async () => { const r = await codemode.test__get_user({ id: 42 }); return JSON.parse(r.content[0].text); }',
        );
        expect(output.result).toEqual({ id: 42, name: 'User 42', email: 'user42@test.com' });
      });

      testOrSkip('should call multiple tools sequentially', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            const sum = await codemode.test__add({ a: 10, b: 20 });
            const product = await codemode.test__multiply({ a: 3, b: 7 });
            return {
              sum: JSON.parse(sum.content[0].text),
              product: JSON.parse(product.content[0].text),
            };
          }`,
        );
        expect(output.result).toEqual({ sum: 30, product: 21 });
      });

      testOrSkip('should call tools in parallel with Promise.all', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            const [r1, r2, r3] = await Promise.all([
              codemode.test__add({ a: 1, b: 1 }),
              codemode.test__add({ a: 2, b: 2 }),
              codemode.test__add({ a: 3, b: 3 }),
            ]);
            return [
              JSON.parse(r1.content[0].text),
              JSON.parse(r2.content[0].text),
              JSON.parse(r3.content[0].text),
            ];
          }`,
        );
        expect(output.result).toEqual([2, 4, 6]);
      });
    });

    // ── Tool Chaining & Data Flow ───────────────────────────────────────

    describe('Tool Chaining', () => {
      testOrSkip('should chain tool outputs as inputs to subsequent tool calls', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            const sumResult = await codemode.test__add({ a: 5, b: 10 });
            const sum = JSON.parse(sumResult.content[0].text);
            const doubled = await codemode.test__multiply({ a: sum, b: 2 });
            return JSON.parse(doubled.content[0].text);
          }`,
        );
        expect(output.result).toBe(30); // (5 + 10) * 2
      });

      testOrSkip('should iterate over tool results', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            const itemsResult = await codemode.test__list_items({ count: 3 });
            const items = JSON.parse(itemsResult.content[0].text);
            const names = items.map(item => item.name);
            return names;
          }`,
        );
        expect(output.result).toEqual(['Item 1', 'Item 2', 'Item 3']);
      });

      testOrSkip('should aggregate results from multiple tool calls', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            let total = 0;
            for (let i = 1; i <= 4; i++) {
              const r = await codemode.test__multiply({ a: i, b: i });
              total += JSON.parse(r.content[0].text);
            }
            return total;
          }`,
        );
        // 1*1 + 2*2 + 3*3 + 4*4 = 1 + 4 + 9 + 16 = 30
        expect(output.result).toBe(30);
      });
    });

    // ── Error Handling ──────────────────────────────────────────────────

    describe('Error Handling', () => {
      testOrSkip('should handle code execution errors gracefully', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { throw new Error("boom"); }' },
        });
        const text = (response as any).content?.[0]?.text || '';
        expect(text).toContain('boom');
      });

      testOrSkip('should handle syntax errors in user code', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { this is not valid javascript!!! }' },
        });
        const text = (response as any).content?.[0]?.text || '';
        expect(text.length).toBeGreaterThan(0);
      });

      testOrSkip('should return error response from upstream tool (does not throw)', async () => {
        // MCP SDK's callTool does NOT throw on upstream tool errors — it returns
        // an error response object. So the sandbox code receives the response,
        // not an exception.
        const output = await callCodemode(
          client,
          `async () => {
            const r = await codemode.test__fail({ message: "test error" });
            return r;
          }`,
        );
        // The response should contain the error information
        expect(output.result).toBeDefined();
        // MCP error responses have isError: true and content with the error text
        const content = output.result?.content?.[0]?.text;
        expect(content).toBeDefined();
        expect(content.toLowerCase()).toContain('error');
      });

      testOrSkip('should handle calling non-existent tools', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { return await codemode.test__nonexistent({}); }' },
        });
        const text = (response as any).content?.[0]?.text || '';
        expect(text.toLowerCase()).toMatch(/error|not found|not defined|not a function/);
      });
    });

    // ── Console Logging ─────────────────────────────────────────────────

    describe('Console Logging', () => {
      testOrSkip('should capture console.log output', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            console.log("hello from sandbox");
            return "done";
          }`,
        );
        expect(output.result).toBe('done');
        expect(output.logs).toBeDefined();
        expect(output.logs).toContain('hello from sandbox');
      });

      testOrSkip('should capture multiple log lines', async () => {
        const output = await callCodemode(
          client,
          `async () => {
            console.log("line 1");
            console.log("line 2");
            console.log("line 3");
            return 42;
          }`,
        );
        expect(output.logs).toHaveLength(3);
        expect(output.logs).toContain('line 1');
        expect(output.logs).toContain('line 2');
        expect(output.logs).toContain('line 3');
      });

      testOrSkip('should not include logs key when no console output', async () => {
        const output = await callCodemode(client, 'async () => { return 1; }');
        expect(output.logs).toBeUndefined();
      });
    });

    // ── Code Normalization ──────────────────────────────────────────────

    describe('Code Normalization', () => {
      testOrSkip('should handle bare return statements (auto-wrapped)', async () => {
        const output = await callCodemode(client, 'return 42;');
        expect(output.result).toBe(42);
      });

      testOrSkip('should handle expression-only code', async () => {
        const output = await callCodemode(client, '1 + 2 + 3');
        expect(output.result).toBe(6);
      });

      testOrSkip('should handle arrow function without async', async () => {
        const output = await callCodemode(client, '() => { return 7; }');
        expect(output.result).toBe(7);
      });
    });

    // ── Isolation & Safety ──────────────────────────────────────────────

    describe('Isolation', () => {
      testOrSkip('should not allow require access', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { return require("node:fs"); }' },
        });
        const text = (response as any).content?.[0]?.text || '';
        expect(text.toLowerCase()).toMatch(/error|not defined|not allowed|requires .* access|could not be cloned/);
      });

      testOrSkip('should not allow process access', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { return process.env; }' },
        });
        const text = (response as any).content?.[0]?.text || '';
        expect(text.toLowerCase()).toMatch(/error|not defined|not allowed|requires .* access|could not be cloned/);
      });

      testOrSkip('should isolate state between executions', async () => {
        await callCodemode(client, 'async () => { globalThis.__test = 123; return "set"; }');

        const output = await callCodemode(
          client,
          'async () => { return typeof globalThis.__test; }',
        );
        expect(output.result).toBe('undefined');
      });
    });

    // ── Response Format ─────────────────────────────────────────────────

    describe('Response Format', () => {
      testOrSkip('should return well-formed MCP content', async () => {
        const response = await client.callTool({
          name: 'eval',
          arguments: { code: 'async () => { return { answer: 42 }; }' },
        });

        expect(response).toHaveProperty('content');
        const content = (response as any).content;
        expect(Array.isArray(content)).toBe(true);
        expect(content.length).toBeGreaterThan(0);
        expect(content[0]).toHaveProperty('type', 'text');
        expect(content[0]).toHaveProperty('text');

        const parsed = JSON.parse(content[0].text);
        expect(parsed).toHaveProperty('code');
        expect(parsed).toHaveProperty('result');
        expect(parsed.result).toEqual({ answer: 42 });
      });

      testOrSkip('should include code field echoing the input', async () => {
        const code = 'async () => { return "test"; }';
        const response = await client.callTool({
          name: 'eval',
          arguments: { code },
        });

        const parsed = JSON.parse((response as any).content[0].text);
        expect(parsed.code).toBe(code);
      });
    });
  });
}
