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
import { z } from "zod";
import { createExecutor, type ExecutorInfo, type ExecutorType } from "./executor.js";
import { adaptAISDKToolToMCP } from "./mcp-adapter.js";
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
    stateless: boolean;
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
  const { executor, info: executorInfo } = await createExecutor(30000, resolvedExecutorType);
  await executor.execute('async () => { return "startup test" }', {});

  // ── Initial eval tool ──────────────────────────────────────────────────────
  logInfo(
    `Creating codemode tool with ${totalToolCount} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
    { component: 'Bridge' }
  );

  const initialCodemodeTool = createCodeTool({
    tools: allToolDescriptors,
    executor,
  });

  // Adapt the AI SDK Tool to MCP protocol and capture the handle for later updates.
  const registeredEvalTool: RegisteredTool = await adaptAISDKToolToMCP(mcp, initialCodemodeTool);

  // ── Live-reload: rebuild the eval tool after server changes ───────────────
  async function rebuildEvalTool(): Promise<void> {
    const descriptors = serverManager.getAllToolDescriptors();
    const count = Object.keys(descriptors).length;

    logInfo(
      `Rebuilding eval tool with ${count} tools from ${serverManager.getConnectedServerNames().length} server(s)`,
      { component: 'Bridge' }
    );

    const codemodeTool = createCodeTool({
      tools: descriptors,
      executor,
    });

    // Update the registered tool in-place.  The SDK will automatically send
    // notifications/tools/list_changed to connected clients.
    registeredEvalTool.update({
      description: codemodeTool.description,
      paramsSchema: codemodeTool.inputSchema as any,
      callback: async (args: any) => {
        try {
          const result = await (codemodeTool.execute as Function)(args);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: "text" as const, text }] } as any;
        } catch (error) {
          return {
            content: [{
              type: "text" as const,
              text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
            }],
          } as any;
        }
      },
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
  const httpOptions = Array.isArray(serverConfigsOrOptions) ? undefined : serverConfigsOrOptions.http;

  // Transport close hook — set by startStdioTransport or startHttpTransport before signals are handled
  let transportCloseFn: (() => Promise<void>) | undefined;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logInfo("Shutting down bridge...", { component: 'Bridge' });
    configWatcher?.stop();
    tokenPersistence.stopWatching();

    if (executor && typeof (executor as any).dispose === 'function') {
      (executor as any).dispose();
    }

    await serverManager.disconnectAll();

    if (transportCloseFn) {
      await transportCloseFn();
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
    await startHttpTransport(mcp, httpOptions, (fn) => { transportCloseFn = fn; });
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
  options: { port: number; host: string; stateless: boolean },
  registerTransportClose: (fn: () => Promise<void>) => void
): Promise<void> {
  const { port, host, stateless } = options;

  if (stateless) {
    // Stateless mode: single transport + single MCP server instance, no session tracking
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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

    await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
    logInfo(`Ready on HTTP transport (stateless): http://${host}:${port}/mcp`, { component: 'Bridge' });
    logInfo(`Health endpoint: http://${host}:${port}/health`, { component: 'Bridge' });

    registerTransportClose(async () => {
      await transport.close();
      httpServer.close();
    });

  } else {
    // Stateful mode: one transport + one MCP server per session, tracked by session ID
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'POST') {
          if (sessionId && transports.has(sessionId)) {
            // Existing session
            const transport = transports.get(sessionId)!;
            const body = await readRequestBody(req);
            await transport.handleRequest(req, res, body);
          } else if (!sessionId) {
            // New session initialisation — create a fresh transport + server
            const sessionTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (newSessionId) => {
                transports.set(newSessionId, sessionTransport);
                logDebug(`Session initialised: ${newSessionId}`, { component: 'Bridge' });
                sessionTransport.onclose = () => {
                  transports.delete(newSessionId);
                  logDebug(`Session closed: ${newSessionId}`, { component: 'Bridge' });
                };
              },
            });

            // Each session gets its own McpServer connected to the shared upstream
            // We reuse the already-registered mcp instance tools by connecting to it
            await mcp.connect(sessionTransport);
            const body = await readRequestBody(req);
            await sessionTransport.handleRequest(req, res, body);
          } else {
            // Unknown session ID
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
          }
        } else if (req.method === 'GET') {
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing or unknown session ID' }));
          }
        } else if (req.method === 'DELETE') {
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
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

    await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
    logInfo(`Ready on HTTP transport (stateful): http://${host}:${port}/mcp`, { component: 'Bridge' });
    logInfo(`Health endpoint: http://${host}:${port}/health`, { component: 'Bridge' });

    registerTransportClose(async () => {
      // Close all open session transports
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
      httpServer.close();
    });
  }
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
