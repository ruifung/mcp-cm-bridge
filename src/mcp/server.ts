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
 * 4. Registers the "eval" tool directly on McpServer using normalizeCode + executor.execute()
 * 5. Exposes the "eval" tool via MCP protocol downstream
 * 6. Watches mcp.json for changes and hot-reloads upstream connections (live reload)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { generateTypes, normalizeCode, sanitizeToolName } from "./schema-utils.js";
import { z } from "zod";
import { createExecutor, type ExecutorInfo, type ExecutorType } from "./executor.js";
import { SessionResolver } from "./session-resolver.js";
import type { ToolDescriptor } from "./server-manager.js";
import { type MCPServerConfig } from "./mcp-client.js";
import { logDebug, logError, logInfo, enableStderrBuffering } from "../utils/logger.js";
import { ServerManager } from "./server-manager.js";
import { ConfigWatcher } from "./config-watcher.js";
import { tokenPersistence } from "./token-persistence.js";
import { loadMCPConfigFile } from "./config.js";
import { BM25SearchProvider, buildSearchEntries } from "./tool-search.js";

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

/**
 * Short, static description for the eval tool.
 * Discovery tools (get_tools, search_tools, get_tool_schema) let the LLM
 * find the correct callable name and parameter types before writing code.
 */
const EVAL_TOOL_DESCRIPTION = `Execute JavaScript/TypeScript code in a sandboxed environment.

## Usage
Write the body of an async function using the \`codemode\` object to call tools:
  const result = await codemode.toolName({ param: "value" });
  return result;

You may also pass a complete async arrow function expression if preferred.

## Discovering available tools
Use the \`name\` field returned by discovery tools as the property on \`codemode\`:
- \`search_tools\` — find tools by keyword
- \`get_tools\` — list tools by server
- \`get_tool_schema\` — get the TypeScript type definition for a specific tool`;

// ── Shared status tool registration ───────────────────────────────────────

function registerStatusTool(
  target: McpServer,
  executorInfo: ExecutorInfo,
  serverManager: ServerManager
): void {
  target.registerTool(
    "status",
    {
      description: "Get the current status of the codemode bridge: executor mode, available tool servers. Use this to obtain a list of tool servers.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const serverInfo = serverManager.getServerToolInfo();
      const totalTools = serverInfo.reduce((sum, s) => sum + s.toolCount, 0);

      const status = {
        executor: {
          type: executorInfo.type,
          reason: executorInfo.reason,
          timeout: executorInfo.timeout,
        },
        servers: serverInfo.map(({ name, toolCount }) => ({ name, toolCount })),
        totalTools,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      } as any;
    }
  );
}

// ── Discovery tools registration ───────────────────────────────────────────

/**
 * Register the three lazy discovery tools on the given McpServer:
 *   - get_tools: list all tools grouped by server
 *   - get_tool_schema: get the TypeScript type definition for a specific tool
 *   - search_tools: keyword-search the tool index
 *
 * @param target       The McpServer to register tools on
 * @param serverManager Source of tool metadata
 * @param searchProvider The search index (must already be built)
 * @param schemaCache  A shared cache keyed by namespaced tool name. Populated
 *                     lazily by get_tool_schema; must be cleared on live-reload.
 */
function registerDiscoveryTools(
  target: McpServer,
  serverManager: ServerManager,
  searchProvider: BM25SearchProvider,
  schemaCache: Map<string, string>
): void {
  // ── get_tools ──────────────────────────────────────────────────────────────
  target.registerTool(
    "get_tools",
    {
      description: "List all available tools grouped by server. Use this to discover what servers and tools are connected to the bridge.",
      inputSchema: z.object({
        server: z.string().optional().describe("Server name to filter by. Omit to list all servers."),
        cursor: z.string().optional().describe("Pagination cursor returned by a previous call. Omit for the first page."),
        pageSize: z.number().int().min(1).max(200).default(50).optional().describe("Number of tools per page (1–200, default 50)."),
      }).strict(),
    },
    async (args) => {
      const flat = serverManager.getToolList(args.server);
      const pageSize = args.pageSize ?? 50;
      const result = paginateToolList({ tools: flat, cursor: args.cursor, pageSize });
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true } as any;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      } as any;
    }
  );

  // ── get_tool_schema ────────────────────────────────────────────────────────
  target.registerTool(
    "get_tool_schema",
    {
      description: "Get the TypeScript type definition for a specific tool. Use the tool name (e.g. gitlab__list_projects) from get_tools or search_tools.",
      inputSchema: z.object({
        tool_name: z.string().describe("Tool name (e.g. gitlab__list_projects)"),
      }).strict(),
    },
    async (args) => {
      const cached = schemaCache.get(args.tool_name);
      if (cached !== undefined) {
        return {
          content: [{ type: "text" as const, text: cached }],
        } as any;
      }

      const descriptor = serverManager.getToolByName(args.tool_name);
      if (!descriptor) {
        return {
          content: [{
            type: "text" as const,
            text: `Tool "${args.tool_name}" not found. Use get_tools to list available tools.`,
          }],
        } as any;
      }

      const snippet = generateTypes({ [args.tool_name]: descriptor });
      schemaCache.set(args.tool_name, snippet);

      return {
        content: [{ type: "text" as const, text: snippet }],
      } as any;
    }
  );

  // ── search_tools ───────────────────────────────────────────────────────────
  target.registerTool(
    "search_tools",
    {
      description: "Search for tools by keyword. Returns matching tools with their names, descriptions, and TypeScript type definitions.",
      inputSchema: z.object({
        query: z.string().describe("Search query (keywords matching tool names and descriptions)"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results to return (default: 5)"),
      }).strict(),
    },
    async (args) => {
      const results = searchProvider.search(args.query, args.limit ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      } as any;
    }
  );
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
  const serverManager = new ServerManager();

  await Promise.all(
    serverConfigs.map((config) => serverManager.connectServer(config.name, config))
  );

  const allToolDescriptors = serverManager.getAllToolDescriptors();
  const totalToolCount = Object.keys(allToolDescriptors).length;

  logInfo(
    `Total: ${totalToolCount} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
    { component: 'Bridge' }
  );

  // Log tools grouped by server
  for (const { name, tools } of serverManager.getServerToolInfo()) {
    if (tools.length > 0) {
      logInfo(`${name}: ${tools.join(', ')}`, { component: 'Bridge', server: name });
    }
  }

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

  const resolveExecutor = (sid?: string) => sessionResolver.resolve(sid);

  // ── Eval tool schema (static) ─────────────────────────────────────────────
  const evalInputSchema = z.object({
    code: z.string().describe("Async arrow function expression to execute"),
  });

  // ── Eval tool handler factory ─────────────────────────────────────────────
  // Returns a fresh handler closure whose getDescriptors() captures the current
  // server state. Called once at registration and again on rebuild so that
  // live-reload picks up the updated tool set without re-registering.
  function makeEvalHandler(getDescriptors: () => Record<string, ToolDescriptor>) {
    return async (args: { code: string }, extra: any) => {
      const sessionId = extra?.sessionId as string | undefined;
      const executor = await resolveExecutor(sessionId);
      const descriptors = getDescriptors();

      const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
      for (const [name, descriptor] of Object.entries(descriptors)) {
        fns[sanitizeToolName(name)] = descriptor.execute;
      }

      const normalizedCode = normalizeCode(args.code);
      const executeResult = await executor.execute(normalizedCode, fns);

      if (executeResult.error) {
        const logCtx = executeResult.logs?.length
          ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
          : "";
        throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
      }

      const output: Record<string, unknown> = { code: args.code, result: executeResult.result };
      if (executeResult.logs?.length) output.logs = executeResult.logs;
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    };
  }

  // ── registerEvalTool ──────────────────────────────────────────────────────
  // Registers the eval tool on a McpServer and returns the handle so the
  // caller can call .update() for live-reload.
  function registerEvalTool(mcpServer: McpServer): RegisteredTool {
    return mcpServer.registerTool(
      "eval",
      {
        description: EVAL_TOOL_DESCRIPTION,
        inputSchema: evalInputSchema,
      },
      makeEvalHandler(() => serverManager.getAllToolDescriptors())
    );
  }

  // ── Per-session eval tool handle map ──────────────────────────────────────
  // Tracks RegisteredTool handles for all active sessions, keyed by session ID.
  // HTTP sessions use their UUID as key; stdio uses '__stdio__'.
  // rebuildEvalTool() iterates this map so live-reload notifications reach
  // every connected client regardless of transport mode.
  const sessionToolHandles = new Map<string, RegisteredTool>();

  // ── Live-reload: rebuild the eval tool after server changes ───────────────
  async function rebuildEvalTool(): Promise<void> {
    const descriptors = serverManager.getAllToolDescriptors();
    const count = Object.keys(descriptors).length;

    // Rebuild search index and clear schema cache so discovery tools reflect
    // the new tool set after a live-reload.
    searchProvider.rebuild(buildSearchEntries(serverManager));
    schemaCache.clear();

    logInfo(
      `Rebuilding eval tool with ${count} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
      { component: 'Bridge' }
    );

    // Build the update payload once and apply it to every active session handle.
    // Description and schema are static; a fresh handler closure is sufficient
    // to pick up the updated descriptor set.
    // Each handle's .update() call triggers tools/list_changed on that session's
    // connected client — whether stdio or HTTP.
    const updatePayload = {
      description: EVAL_TOOL_DESCRIPTION,
      paramsSchema: evalInputSchema as any,
      callback: makeEvalHandler(() => serverManager.getAllToolDescriptors()),
    };

    for (const handle of sessionToolHandles.values()) {
      handle.update(updatePayload);
    }

    logInfo(
      `Eval tool rebuilt and tool-list-changed notification sent to ${sessionToolHandles.size} session(s)`,
      { component: 'Bridge' }
    );

    // Log updated tool breakdown by server
    for (const { name, tools } of serverManager.getServerToolInfo()) {
      if (tools.length > 0) {
        logInfo(`${name}: ${tools.join(', ')}`, { component: 'Bridge', server: name });
      }
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
        onServersChanged: rebuildEvalTool,
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
      const registeredEvalTool = registerEvalTool(mcpServer);

      // Register the status tool
      registerStatusTool(mcpServer, executorInfo, serverManager);

      // Register the discovery tools
      registerDiscoveryTools(mcpServer, serverManager, searchProvider, schemaCache);

      return { mcpServer, registeredEvalTool };
    };

    await startHttpTransport(httpOptions, executorInfo, (fn) => { transportCloseFn = fn; }, buildMcpServer, sessionToolHandles);
  } else {
    // stdio mode: create the single global McpServer and register tools on it.
    const mcp = new McpServer({ name: "codemode-bridge", version: "1.0.0" });

    logInfo(
      `Creating eval tool with ${totalToolCount} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
      { component: 'Bridge' }
    );

    // Register the eval tool directly and store the handle for live-reload.
    const stdioEvalHandle = registerEvalTool(mcp);
    sessionToolHandles.set('__stdio__', stdioEvalHandle);

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
  logInfo(`Exposing 'codemode' and 'status' tools`, { component: 'Bridge' });

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
  sessionToolHandles: Map<string, RegisteredTool>
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
              // Store the eval tool handle for this session so rebuildEvalTool()
              // can push live-reload updates to it.
              sessionToolHandles.set(sid, registeredEvalTool);
              logInfo(`Session initialized: ${sid}`, { component: 'Bridge' });
              // Capture sid in closure for O(1) cleanup on close
              transport.onclose = () => {
                sessions.delete(sid);
                sessionToolHandles.delete(sid);
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
          sessionToolHandles.delete(sessionId);
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
    sessionToolHandles.clear();
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
