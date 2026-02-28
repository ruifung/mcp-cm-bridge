/**
 * MCP Server - Exposes the Code Mode bridge as an MCP server
 *
 * Architecture:
 * - Upstream: Use official MCP SDK's Client to connect to and collect tools from other MCP servers
 * - Orchestration: Inline eval-tool logic using normalizeCode + executor.execute()
 * - Downstream: Use MCP SDK to expose the codemode tool via MCP protocol (stdio or HTTP transport)
 *
 * This server:
 * 1. Connects to upstream MCP servers using official MCP SDK Client
 * 2. Collects tools from all upstream servers in native MCP format (JSON Schema)
 * 3. Converts tools to ToolDescriptor format (with Zod schemas)
 * 4. Registers the "sandbox_eval_js" tool directly on McpServer using normalizeCode + executor.execute()
 * 5. Exposes the "sandbox_eval_js" tool via MCP protocol downstream
 * 6. Watches mcp.json for changes and hot-reloads upstream connections (live reload)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as jsYaml from "js-yaml";
import { generateTypes, normalizeCode, sanitizeToolName } from "./schema-utils.js";
import { z } from "zod";
import { createExecutor, type ExecutorInfo, type ExecutorType } from "./executor.js";
import { SessionResolver } from "./session-resolver.js";
import type { ToolDescriptor } from "./upstream-mcp-client-manager.js";
import { type MCPServerConfig } from "./mcp-client.js";
import { logDebug, logError, logInfo, enableStderrBuffering } from "../utils/logger.js";
import { UpstreamMcpClientManager } from "./upstream-mcp-client-manager.js";
import { ConfigWatcher } from "./config-watcher.js";
import { tokenPersistence } from "./token-persistence.js";
import { loadMCPConfigFile } from "./config.js";
import { BM25SearchProvider, buildSearchEntries } from "./tool-search.js";
import {SandboxManager} from "@/sandbox/manager.js";
import {SandboxEvalTool} from "@/tools/SandboxEvalTool.js";
import {BridgeStatusTool} from "@/tools/BridgeStatusTool.js";

// Re-export MCPServerConfig and ExecutorType for backwards compatibility
export type { MCPServerConfig, ExecutorType }
// Re-export jsonSchemaToZod for backwards compatibility (moved to schema-utils.ts)
export { jsonSchemaToZod } from "./schema-utils.js";

// ── Cursor-based pagination for get_tools ─────────────────────────────────────

export interface PaginateInput {
  tools: Array<{ server: string; name: string; description: string }>;
  cursor?: string;   // base64url-encoded JSON { o: number }
  pageSize: number;  // already validated: 1–200
}

export interface PaginateOutput {
  data: Array<{ server: string; tools: Array<{ name: string; description: string }> }>;
  nextCursor?: string;
  totalTools: number;
}

/**
 * Slice a flat tool list into a cursor-paginated page and group by server.
 *
 * Returns `{ error: string }` when the cursor is syntactically invalid so the
 * caller can surface a meaningful error without throwing.
 */
export function paginateToolList(input: PaginateInput): PaginateOutput | { error: string } {
  const { tools, cursor, pageSize } = input;

  // Decode cursor → offset
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        !('o' in decoded) ||
        typeof (decoded as any).o !== 'number' ||
        !Number.isInteger((decoded as any).o) ||
        (decoded as any).o < 0
      ) {
        return { error: 'Invalid cursor' };
      }
      offset = (decoded as { o: number }).o;
    } catch {
      return { error: 'Invalid cursor' };
    }
  }

  // Slice the flat list
  const page = tools.slice(offset, offset + pageSize);

  // Group by server
  const grouped = new Map<string, Array<{ name: string; description: string }>>();
  for (const entry of page) {
    if (!grouped.has(entry.server)) {
      grouped.set(entry.server, []);
    }
    grouped.get(entry.server)!.push({ name: entry.name, description: entry.description });
  }

  const data = Array.from(grouped.entries()).map(([serverName, serverTools]) => ({
    server: serverName,
    tools: serverTools,
  }));

  // Compute nextCursor
  const nextOffset = offset + pageSize;
  const nextCursor =
    nextOffset < tools.length
      ? Buffer.from(JSON.stringify({ o: nextOffset })).toString('base64url')
      : undefined;

  return {
    data,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    totalTools: tools.length,
  };
}


// ── Shared status tool registration ───────────────────────────────────────

function registerStatusTool(
  target: McpServer,
  executorInfo: ExecutorInfo,
  serverManager: UpstreamMcpClientManager
): void {
  new BridgeStatusTool(executorInfo, serverManager).registerWithMcpServer(target)
}

// ── Discovery tools registration ───────────────────────────────────────────

/**
 * Register the three lazy discovery tools on the given McpServer:
 *   - sandbox_get_functions: list all tools grouped by server
 *   - sandbox_get_function_schema: get the TypeScript type definition for a specific tool
 *   - sandbox_search_functions: keyword-search the tool index
 *
 * @param target       The McpServer to register tools on
 * @param sandboxManager Source of tool metadata
 * @param searchProvider The search index (must already be built)
 * @param schemaCache  A shared cache keyed by namespaced tool name. Populated
 *                     lazily by get_tool_schema; must be cleared on live-reload.
 */
function registerDiscoveryTools(
  target: McpServer,
  sandboxManager: SandboxManager,
  searchProvider: BM25SearchProvider,
  schemaCache: Map<string, string>
): void {
  // ── sandbox_get_functions ──────────────────────────────────────────────────────
  target.registerTool(
    "sandbox_get_functions",
    {
      description: "List available functions grouped by server. Each entry includes the function name and its description. Use the returned name value as the property name on the codemode object when writing code for sandbox_eval_js, and as the tool_name argument when calling sandbox_get_function_schema.\n\nFunction names follow the pattern serverName__functionName, where a double underscore separates the server namespace from the original function name. For example, a function called list_items on a server named inventory becomes inventory__list_items.\n\nResults are paginated. The first call returns the first page. If the response includes a nextCursor value, pass it as the cursor parameter to retrieve the next page.",
      inputSchema: z.object({
        server: z.string().optional().describe("Filter results to a single server by name. Omit this parameter to list functions from all connected servers."),
        cursor: z.string().optional().describe("Pagination cursor returned in the nextCursor field of a previous response. Omit this parameter for the first page. The cursor is opaque. Do not parse or construct it yourself."),
        pageSize: z.number().int().min(1).max(200).default(50).optional().describe("Number of functions to return per page. Must be between 1 and 200. Defaults to 50 if omitted."),
      }).strict(),
      outputSchema: z.object({
        tools: z.array(z.object({
          server: z.string(),
          name: z.string(),
          description: z.string(),
          schema: z.string().optional(),
        })),
        nextCursor: z.string().optional(),
      }),
    },
    async (args) => {
      const flat = sandboxManager.getToolList(args.server);
      const pageSize = args.pageSize ?? 50;
      const result = paginateToolList({ tools: flat, cursor: args.cursor, pageSize });
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true, structuredContent: { tools: [] } } as any;
      }
      // Decode cursor offset to find which slice was returned
      let offset = 0;
      if (args.cursor !== undefined) {
        try {
          offset = (JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as { o: number }).o;
        } catch { /* use 0 */ }
      }
      const pageTools = flat.slice(offset, offset + pageSize);
      const structuredContent: { tools: Array<{ server: string; name: string; description: string; schema?: string }>; nextCursor?: string } = {
        tools: pageTools.map((t) => ({ server: t.namespace, name: t.name, description: t.description })),
      };
      if (result.nextCursor !== undefined) structuredContent.nextCursor = result.nextCursor;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent,
      } as any;
    }
  );

  // ── sandbox_get_function_schema ────────────────────────────────────────────
  target.registerTool(
    "sandbox_get_function_schema",
    {
      description: "Return the TypeScript type definition for a specific function. The output includes the input parameter types, the return type, and JSDoc comments describing each parameter. Use this to determine the exact parameter names, types, and which parameters are required before writing code for sandbox_eval_js.\n\nPass the function name exactly as returned by sandbox_get_functions or sandbox_search_functions (for example, server_name__function_name).",
      inputSchema: z.object({
        tool_name: z.string().describe("The function name to look up, exactly as returned by sandbox_get_functions or sandbox_search_functions. Example: server_name__function_name."),
      }).strict(),
      outputSchema: z.object({
        typeScript: z.string(),
      }),
    },
    async (args) => {
      const cached = schemaCache.get(args.tool_name);
      if (cached !== undefined) {
        return {
          content: [{ type: "text" as const, text: cached }],
          structuredContent: { typeScript: cached },
        } as any;
      }

      const descriptor = serverManager.getToolByName(args.tool_name);
      if (!descriptor) {
        return {
          content: [{
            type: "text" as const,
            text: `Tool "${args.tool_name}" not found. Use sandbox_get_functions to list available tools.`,
          }],
          isError: true,
          structuredContent: { typeScript: "" },
        } as any;
      }

      const snippet = generateTypes({ [args.tool_name]: descriptor });
      schemaCache.set(args.tool_name, snippet);

      return {
        content: [{ type: "text" as const, text: snippet }],
        structuredContent: { typeScript: snippet },
      } as any;
    }
  );

  // ── sandbox_search_functions ───────────────────────────────────────────────────
  target.registerTool(
    "sandbox_search_functions",
    {
      description: "Search for functions by keyword. Matches against function names and descriptions. Returns the top results ranked by relevance. Each result includes the function name and its description, and may include a TypeScript type definition. If you need exact parameter names and types, call sandbox_get_function_schema. Use this instead of sandbox_get_functions when you know what you are looking for but do not know the exact function name.",
      inputSchema: z.object({
        query: z.string().describe("One or more keywords to search for. Matched against function names and descriptions. Example: list projects."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum number of results to return. Must be between 1 and 20. Defaults to 5 if omitted."),
      }).strict(),
      outputSchema: z.object({
        tools: z.array(z.object({
          name: z.string(),
          description: z.string(),
          schema: z.string().optional(),
        })),
      }),
    },
    async (args) => {
      const results = searchProvider.search(args.query, args.limit ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        structuredContent: { tools: results },
      } as any;
    }
  );
}

// ── Utils virtual server registration ─────────────────────────────────────

/**
 * Register the built-in `utils` virtual server on the given ServerManager.
 * All tools run in-process — no upstream MCP connection is created.
 */
function registerUtilsServer(serverManager: UpstreamMcpClientManager): void {
  const yamlParseDescriptor: ToolDescriptor = {
    name: "yaml__parse",
    description: "Parse a YAML string into a JavaScript value",
    inputSchema: z.object({ input: z.string().describe("YAML string to parse") }),
    rawSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "YAML string to parse" },
      },
      required: ["input"],
    },
    outputSchema: z.object({ result: z.any() }),
    execute: async (args: { input: string }) => {
      try {
        const result = jsYaml.load(args.input, { schema: jsYaml.CORE_SCHEMA });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { result },
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `YAML parse error: ${message}` }],
          isError: true,
          structuredContent: { result: null },
        };
      }
    },
  };

  const yamlStringifyDescriptor: ToolDescriptor = {
    name: "yaml__stringify",
    description: "Serialize a JavaScript value to a YAML string",
    inputSchema: z.object({ input: z.any().describe("Value to serialize to YAML") }),
    rawSchema: {
      type: "object",
      properties: {
        input: { description: "Value to serialize to YAML" },
      },
      required: ["input"],
    },
    outputSchema: z.object({ result: z.string() }),
    execute: async (args: { input: unknown }) => {
      try {
        const result = jsYaml.dump(args.input, { schema: jsYaml.CORE_SCHEMA });
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { result },
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `YAML stringify error: ${message}` }],
          isError: true,
          structuredContent: { result: "" },
        };
      }
    },
  };

  serverManager.registerServer("utils", {
    "utils__yaml__parse": yamlParseDescriptor,
    "utils__yaml__stringify": yamlStringifyDescriptor,
  });
}

export interface StartServerOptions {
  serverConfigs: MCPServerConfig[];
  executorType?: ExecutorType;
  /** Absolute path to the mcp.json config file — enables live reload when provided. */
  configPath?: string;
  /** If provided, only servers in this list are managed (passed through from --servers CLI flag). */
  serverFilter?: string[];
  /** When provided, start an HTTP server instead of using stdio transport. */
  http?: {
    port: number;
    host: string;
  };
}

export async function startCodeModeBridgeServer(
  serverConfigsOrOptions: MCPServerConfig[] | StartServerOptions,
  executorType?: ExecutorType
) {
  // Normalise the overloaded signature.
  let serverConfigs: MCPServerConfig[];
  let resolvedExecutorType: ExecutorType | undefined;
  let configPath: string | undefined;
  let serverFilter: string[] | undefined;

  if (Array.isArray(serverConfigsOrOptions)) {
    // Legacy call: startCodeModeBridgeServer(configs, executorType?)
    serverConfigs = serverConfigsOrOptions;
    resolvedExecutorType = executorType;
  } else {
    // New call: startCodeModeBridgeServer({ serverConfigs, executorType, configPath, serverFilter })
    serverConfigs = serverConfigsOrOptions.serverConfigs;
    resolvedExecutorType = serverConfigsOrOptions.executorType;
    configPath = serverConfigsOrOptions.configPath;
    serverFilter = serverConfigsOrOptions.serverFilter;
  }

  // Enable buffering of stderr output from stdio tools during startup
  enableStderrBuffering();

  // ── Connect all upstream servers via ServerManager ─────────────────────────
  const sandboxManager = new SandboxManager();
  const serverManager = new UpstreamMcpClientManager(sandboxManager);

  // Register built-in virtual servers before connecting real upstream servers
  registerUtilsServer(serverManager);

  // ── Search index + schema cache for discovery tools ───────────────────────
  const searchProvider = new BM25SearchProvider();
  searchProvider.build(buildSearchEntries(serverManager));
  const schemaCache = new Map<string, string>();

  // ── Executor ───────────────────────────────────────────────────────────────
  // The singleton executor is always created.  In stdio mode it handles all
  // requests.  In HTTP mode it serves as the fallback when no sessionId is
  // available (e.g. status tool) and provides the initial executorInfo.
  // In HTTP mode the singleton has a 30-min idle timeout (same as per-session
  // executors) and is lazily re-created on demand after expiry.

  const httpOptions = Array.isArray(serverConfigsOrOptions) ? undefined : serverConfigsOrOptions.http;

  const { executor: initialExecutor, info: executorInfo } = await createExecutor(30000, resolvedExecutorType);
  await initialExecutor.execute('async () => { return "startup test" }', {});


  // ── SessionResolver ────────────────────────────────────────────────────────
  const sessionResolver = new SessionResolver({
    createExecutor: (timeout) => createExecutor(timeout, resolvedExecutorType),
    initialExecutor,
    initialExecutorInfo: executorInfo,
    isHttpMode: !!httpOptions,
    log: {
      info: (msg) => logInfo(msg, { component: 'Bridge' }),
      error: (msg, err) => logError(msg, err as Error | Record<string, any>),
    },
  });

  const sandboxEvalTool = new SandboxEvalTool(sessionResolver, sandboxManager);

  // ── Background connect upstream servers ───────────────────────────────────
  if (serverConfigs.length > 0) {
    logInfo(
      `Starting background connections to ${serverConfigs.length} server(s)...`,
      { component: 'Bridge' }
    );
    for (const config of serverConfigs) {
      serverManager.connectServerInBackground(config.name, config);
    }
  }

  // ── Config watcher (live reload) ───────────────────────────────────────────
  let configWatcher: ConfigWatcher | undefined;
  if (configPath) {
    try {
      const initialConfig = loadMCPConfigFile(configPath);
      configWatcher = new ConfigWatcher({
        configPath,
        serverFilter,
        serverManager,
        onServersChanged: async () => {}
      });
      configWatcher.start(initialConfig);
    } catch (error) {
      // Non-fatal: if the initial config can't be read for the watcher we
      // just skip live reload rather than crashing the bridge.
      logError(
        `Could not start config watcher (live reload disabled): ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : { error: String(error) }
      );
    }
  }

  // ── Token persistence watcher ──────────────────────────────────────────────
  tokenPersistence.startWatching();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let isShuttingDown = false;

  // Transport close hook — set by startStdioTransport or startHttpTransport before signals are handled
  let transportCloseFn: (() => Promise<void>) | undefined;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logInfo("Shutting down bridge...", { component: 'Bridge' });
    configWatcher?.stop();
    tokenPersistence.stopWatching();

    // Dispose all per-session executors and the singleton executor
    await sessionResolver.disposeAll();

    await serverManager.disconnectAll();

    if (transportCloseFn) {
      await transportCloseFn();
    }

    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // ── Connect downstream transport ───────────────────────────────────────────
  //
  // Architecture:
  //   stdio mode  — A single global McpServer is created and connected to
  //                 StdioServerTransport. Its eval tool handle is stored in
  //                 sessionToolHandles under key '__stdio__'.
  //   HTTP mode   — No global McpServer. buildMcpServer() creates a fresh
  //                 McpServer for each connecting client. Handles are stored in
  //                 sessionToolHandles keyed by session UUID and cleaned up on
  //                 disconnect. The global `mcp` variable is not used.
  //
  // rebuildEvalTool() iterates sessionToolHandles to push live-reload updates
  // to all active connections regardless of transport mode.

  if (httpOptions) {
    // Factory: creates a fresh McpServer + eval tool handle for each new HTTP session.
    // Returns both so startHttpTransport can store the handle in sessionToolHandles.
    const buildMcpServer = async (): Promise<{ mcpServer: McpServer; registeredEvalTool: RegisteredTool }> => {
      const mcpServer = new McpServer({ name: "codemode-bridge", version: "1.0.0" });

      // Register the eval tool directly (session-aware: each call resolves its own executor via sessionId)
      const registeredEvalTool = sandboxEvalTool.registerWithMcpServer(mcpServer);

      // Register the status tool
      registerStatusTool(mcpServer, executorInfo, serverManager);

      // Register the discovery tools
      registerDiscoveryTools(mcpServer, serverManager, searchProvider, schemaCache);

      return { mcpServer, registeredEvalTool };
    };

    await startHttpTransport(httpOptions, executorInfo, (fn) => { transportCloseFn = fn; }, buildMcpServer);
  } else {
    // stdio mode: create the single global McpServer and register tools on it.
    const mcp = new McpServer({ name: "codemode-bridge", version: "1.0.0" });

    logInfo(
      `Creating eval tool with ${Object.keys(serverManager.getAllToolDescriptors()).length} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
      { component: 'Bridge' }
    );

    sandboxEvalTool.registerWithMcpServer(mcp)

    registerStatusTool(mcp, executorInfo, serverManager);

    // Register the discovery tools
    registerDiscoveryTools(mcp, serverManager, searchProvider, schemaCache);

    await startStdioTransport(mcp, shutdown, (fn) => { transportCloseFn = fn; });
  }
}

// ── Stdio transport helper ─────────────────────────────────────────────────

async function startStdioTransport(
  mcp: McpServer,
  shutdown: () => Promise<void>,
  registerTransportClose: (fn: () => Promise<void>) => void
): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Register the transport close hook for graceful shutdown
  registerTransportClose(() => transport.close());

  logInfo(`Ready on stdio transport`, { component: 'Bridge' });
  logDebug(`Registering tool request handler`, { component: 'Bridge' });
  logInfo(`Exposing 'codemode' and 'sandbox_status' tools`, { component: 'Bridge' });

  // Also handle stdin close events for stdio transport
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

// ── HTTP transport helper ──────────────────────────────────────────────────

async function startHttpTransport(
  options: { port: number; host: string },
  executorInfo: ExecutorInfo,
  registerTransportClose: (fn: () => Promise<void>) => void,
  buildMcpServer: () => Promise<{ mcpServer: McpServer; registeredEvalTool: RegisteredTool }>,
): Promise<void> {
  const { port, host } = options;

  // Per-session transport map: session ID → transport instance
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'POST') {
        const body = await readRequestBody(req);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session — route to its transport
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          // New session — create a fresh transport + McpServer pair.
          // buildMcpServer() is called first so the registeredEvalTool is
          // available when onsessioninitialized fires with the session ID.
          const { mcpServer, registeredEvalTool } = await buildMcpServer();

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, transport);
              logInfo(`Session initialized: ${sid}`, { component: 'Bridge' });
              // Capture sid in closure for O(1) cleanup on close
              transport.onclose = () => {
                sessions.delete(sid);
                logInfo(`Session closed: ${sid}`, { component: 'Bridge' });
              };
            },
          });

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, body);
        } else {
          // No session header and not an initialize request — reject
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }));
        }
      } else if (req.method === 'GET') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.handleRequest(req, res);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown or missing session ID' }));
        }
      } else if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res);
          sessions.delete(sessionId);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown or missing session ID' }));
        }
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  // The singleton executor already pulled the container image at startup.
  if (executorInfo.type === 'container') {
    logInfo('Container image already pre-pulled via startup executor', { component: 'Bridge' });
  }

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  logInfo(`Ready on HTTP transport: http://${host}:${port}/mcp`, { component: 'Bridge' });
  logInfo(`Health endpoint: http://${host}:${port}/health`, { component: 'Bridge' });

  registerTransportClose(async () => {
    // Close all active session transports and clear tracking maps
    await Promise.all([...sessions.values()].map((t) => t.close().catch(() => {})));
    sessions.clear();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });
}

// ── Utility ────────────────────────────────────────────────────────────────

function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}
