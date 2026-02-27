/**
 * MCP Server - Exposes the Code Mode bridge as an MCP server
 * 
 * Architecture:
 * - Upstream: Use official MCP SDK's Client to connect to and collect tools from other MCP servers
 * - Orchestration: Pass collected tools to codemode SDK's createCodeTool()
 * - Downstream: Use MCP SDK to expose the codemode tool via MCP protocol (stdio or HTTP transport)
 * 
 * This server:
 * 1. Connects to upstream MCP servers using official MCP SDK Client
 * 2. Collects tools from all upstream servers in native MCP format (JSON Schema)
 * 3. Converts tools to ToolDescriptor format (with Zod schemas)
 * 4. Uses @cloudflare/codemode SDK to create the "codemode" tool with those tools
 * 5. Adapts the codemode SDK's AI SDK Tool to MCP protocol using a shim layer
 * 6. Exposes the "codemode" tool via MCP protocol downstream
 * 7. Watches mcp.json for changes and hot-reloads upstream connections (live reload)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { Executor } from "@cloudflare/codemode";
import { z } from "zod";
import { createExecutor, type ExecutorInfo, type ExecutorType } from "./executor.js";
import { adaptAISDKToolToMCP, createSessionAwareToolHandler, type ExecutorResolver } from "./mcp-adapter.js";
import { SessionResolver } from "./session-resolver.js";
import type { RegisteredTool } from "./mcp-adapter.js";
import { MCPClient, type MCPServerConfig, type MCPTool } from "./mcp-client.js";
import { logDebug, logError, logInfo, enableStderrBuffering } from "../utils/logger.js";
import { ServerManager } from "./server-manager.js";
import { ConfigWatcher } from "./config-watcher.js";
import { tokenPersistence } from "./token-persistence.js";
import { loadMCPConfigFile } from "./config.js";

// Re-export MCPServerConfig and ExecutorType for backwards compatibility
export type { MCPServerConfig, ExecutorType }

/**
 * Convert JSON Schema to Zod schema
 * MCP tools use JSON Schema, but createCodeTool expects Zod schemas
 */
export function jsonSchemaToZod(schema: any): z.ZodType<any> {
  // Handle null/undefined
  if (!schema) {
    return z.object({}).strict();
  }

  // Handle object type
  if (schema.type === "object" || !schema.type) {
    const props: Record<string, z.ZodType<any>> = {};
    
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        props[key] = jsonSchemaToZod(prop as any);
      }
    }

    if (schema.required && Array.isArray(schema.required)) {
      const required = new Set(schema.required);
      const finalProps: Record<string, z.ZodType<any>> = {};
      
      for (const [key, zodSchema] of Object.entries(props)) {
        if (required.has(key)) {
          finalProps[key] = zodSchema;
        } else {
          finalProps[key] = (zodSchema as any).optional();
        }
      }
      return z.object(finalProps).strict();
    }
    
    // Make all fields optional if no required list
    const optionalProps: Record<string, z.ZodType<any>> = {};
    for (const [key, zodSchema] of Object.entries(props)) {
      optionalProps[key] = (zodSchema as any).optional();
    }
    return z.object(optionalProps).strict();
  }

  // Handle array type
  if (schema.type === "array") {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    let arraySchema = z.array(itemSchema);
    
    // Apply array constraints
    if (typeof schema.minItems === "number") {
      arraySchema = arraySchema.min(schema.minItems);
    }
    if (typeof schema.maxItems === "number") {
      arraySchema = arraySchema.max(schema.maxItems);
    }
    
    return arraySchema;
  }

  // Handle string type
  if (schema.type === "string") {
    let stringSchema = z.string();
    
    // Handle enum
    if (schema.enum && Array.isArray(schema.enum)) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    
    // Apply string format constraints
    if (schema.format) {
      switch (schema.format) {
        case "email":
          stringSchema = stringSchema.email();
          break;
        case "uuid":
          stringSchema = stringSchema.uuid();
          break;
        case "url":
          stringSchema = stringSchema.url();
          break;
        case "date-time":
          stringSchema = stringSchema.datetime();
          break;
      }
    }
    
    // Apply string length constraints
    if (typeof schema.minLength === "number") {
      stringSchema = stringSchema.min(schema.minLength);
    }
    if (typeof schema.maxLength === "number") {
      stringSchema = stringSchema.max(schema.maxLength);
    }
    if (schema.pattern) {
      stringSchema = stringSchema.regex(new RegExp(schema.pattern));
    }
    
    return stringSchema;
  }

  // Handle number type
  if (schema.type === "number") {
    let numberSchema = z.number();
    
    // Apply number constraints
    if (typeof schema.minimum === "number") {
      numberSchema = numberSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      numberSchema = numberSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      numberSchema = numberSchema.multipleOf(schema.multipleOf);
    }
    
    return numberSchema;
  }

  // Handle integer type
  if (schema.type === "integer") {
    let intSchema = z.number().int();
    
    // Apply number constraints
    if (typeof schema.minimum === "number") {
      intSchema = intSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      intSchema = intSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      intSchema = intSchema.multipleOf(schema.multipleOf);
    }
    
    return intSchema;
  }

  // Handle boolean type
  if (schema.type === "boolean") {
    return z.boolean();
  }

  // Handle null type
  if (schema.type === "null") {
    return z.null();
  }

  // Handle anyOf (union types)
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const schemas = schema.anyOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle oneOf (discriminated union)
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const schemas = schema.oneOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle allOf (intersection types)
  if (schema.allOf && Array.isArray(schema.allOf)) {
    // Zod doesn't have native intersection for objects, so merge them
    let merged: z.ZodType<any> = z.object({});
    for (const subSchema of schema.allOf) {
      const zodSchema = jsonSchemaToZod(subSchema);
      merged = (merged as any).and(zodSchema);
    }
    return merged;
  }

  // Handle enum for non-string types
  if (schema.enum && Array.isArray(schema.enum)) {
    if (schema.enum.length === 1) {
      return z.literal(schema.enum[0]);
    }
    // Create union of literals
    const literals = schema.enum.map((val: any) => z.literal(val));
    return z.union(literals as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Default to any
  return z.any();
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

  const mcp = new McpServer({
    name: "codemode-bridge",
    version: "1.0.0",
  });

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

  const resolveExecutor: ExecutorResolver = (sid) => sessionResolver.resolve(sid);

  // ── Initial eval tool ──────────────────────────────────────────────────────
  logInfo(
    `Creating codemode tool with ${totalToolCount} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
    { component: 'Bridge' }
  );

  const initialCodemodeTool = createCodeTool({
    tools: allToolDescriptors,
    executor: initialExecutor,
  });

  // Adapt the AI SDK Tool to MCP protocol and capture the handle for later updates.
  // In HTTP mode pass the resolver so each invocation gets the session's executor.
  // In stdio mode (no httpOptions) the resolver is still passed; since all stdio
  // calls arrive without a sessionId, resolveExecutor will return singletonExecutor.
  const registeredEvalTool: RegisteredTool = await adaptAISDKToolToMCP(
    mcp,
    initialCodemodeTool,
    resolveExecutor,
    () => serverManager.getAllToolDescriptors()
  );

  // ── Live-reload: rebuild the eval tool after server changes ───────────────
  async function rebuildEvalTool(): Promise<void> {
    const descriptors = serverManager.getAllToolDescriptors();
    const count = Object.keys(descriptors).length;

    logInfo(
      `Rebuilding eval tool with ${count} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
      { component: 'Bridge' }
    );

    // Build a reference tool with the singleton executor just to get the
    // updated description and inputSchema from createCodeTool.
    // resolve() with no sessionId always routes to the singleton session,
    // lazily re-creating it if it was disposed by the idle timer.
    const singletonForRebuild = await sessionResolver.resolve();
    const referenceTool = createCodeTool({
      tools: descriptors,
      executor: singletonForRebuild,
    });

    // Update the registered tool in-place.  The SDK will automatically send
    // notifications/tools/list_changed to connected clients.
    // The callback uses the same per-session resolver pattern as the initial
    // registration so executor isolation is preserved after a live reload.
    registeredEvalTool.update({
      description: referenceTool.description,
      paramsSchema: referenceTool.inputSchema as any,
      callback: createSessionAwareToolHandler(resolveExecutor, () => serverManager.getAllToolDescriptors()),
    });

    logInfo('Eval tool rebuilt and tool-list-changed notification sent', { component: 'Bridge' });

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

  // ── Status tool ────────────────────────────────────────────────────────────
  mcp.registerTool(
    "status",
    {
      description: "Get the current status of the codemode bridge: executor mode, upstream server connections, and available tools.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const servers = serverManager.getServerToolInfo();
      const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);

      const status = {
        executor: {
          type: executorInfo.type,
          reason: executorInfo.reason,
          timeout: executorInfo.timeout,
        },
        servers,
        totalTools,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      } as any;
    }
  );

  // ── Connect downstream transport ───────────────────────────────────────────
  if (httpOptions) {
    await startHttpTransport(mcp, httpOptions, executorInfo, (fn) => { transportCloseFn = fn; });
  } else {
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
  mcp: McpServer,
  options: { port: number; host: string },
  executorInfo: ExecutorInfo,
  registerTransportClose: (fn: () => Promise<void>) => void
): Promise<void> {
  const { port, host } = options;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await mcp.connect(transport);

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
        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        await transport.handleRequest(req, res);
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
    await transport.close();
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
