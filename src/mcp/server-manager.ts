/**
 * ServerManager - manages the lifecycle of upstream MCP server connections.
 *
 * Encapsulates the connect / disconnect / list-tools logic that was previously
 * inlined in startCodeModeBridgeServer().  ServerManager keeps a registry of
 * currently-connected servers and exposes a flat view of all their tools for
 * use by the eval-tool builder.
 */

import { MCPClient, type MCPServerConfig, type MCPTool } from "./mcp-client.js";
import { logDebug, logError, logInfo, logWarn } from "../utils/logger.js";
import { sanitizeToolName, jsonSchemaToZod } from "./schema-utils.js";

/**
 * Connection lifecycle state for an upstream MCP server.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'awaiting-auth' | 'connected' | 'failed';

/**
 * Detailed information about a server's connection state, used for status
 * reporting and retry bookkeeping.
 */
export interface ServerConnectionInfo {
  state: ConnectionState;
  error?: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: Date;
}

/**
 * A single upstream server connection with its resolved tools.
 * `client` is optional/null for virtual servers that have no real upstream connection.
 */
export interface ManagedServer {
  name: string;
  config: MCPServerConfig;
  client?: MCPClient | null;
  /** Namespaced tool descriptors keyed by "<serverName>__<toolName>" */
  tools: Record<string, ToolDescriptor>;
  connectionInfo?: ServerConnectionInfo;
}

/**
 * A tool descriptor ready to be passed to createCodeTool().
 */
export interface ToolDescriptor {
  description: string;
  inputSchema: any; // Zod schema
  outputSchema?: any; // Zod schema (optional)
  /** Original JSON Schema from the upstream MCP server, before Zod conversion. */
  rawSchema: any;
  execute: (args: any) => Promise<any>;
}

export class ServerManager {
  private servers = new Map<string, ManagedServer>();
  private connectionInfos = new Map<string, ServerConnectionInfo>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Connect to a single upstream MCP server, list its tools, and register
   * them in the internal map.  If the connection fails, a warning is logged
   * and the server is skipped (does NOT throw).
   */
  async connectServer(name: string, config: MCPServerConfig): Promise<boolean> {
    try {
      await this.tryConnect(name, config);
      return true;
    } catch (error) {
      logError(
        `Failed to connect to "${name}"`,
        error instanceof Error ? error : { error: String(error) }
      );
      return false;
    }
  }

  /**
   * Internal method that performs the actual connection work and throws on
   * failure.  `connectServer()` wraps this with a try/catch for the public
   * boolean API; `connectServerInBackground()` calls it directly so it can
   * inspect the thrown error.
   */
  private async tryConnect(name: string, config: MCPServerConfig): Promise<void> {
    const client = new MCPClient(config);
    await client.connect();

    const serverTools = await client.listTools();
    const toolCount = serverTools.length;

    logDebug(`Server "${name}" has ${toolCount} tools`, { component: 'ServerManager' });

    const tools: Record<string, ToolDescriptor> = {};
    for (const tool of serverTools) {
      const namespacedName = `${name}__${tool.name}`;
      tools[namespacedName] = this.buildDescriptor(tool, client, tool.name, name);
    }

    this.servers.set(name, { name, config, client, tools });

    logInfo(`Connected to "${name}" (${toolCount} tool${toolCount !== 1 ? 's' : ''})`, { component: 'ServerManager' });
  }

  /**
   * Fire-and-forget: connect to an upstream server in the background with
   * exponential-backoff retry.  Returns immediately.
   *
   * @param name      Server name (must match MCPServerConfig.name)
   * @param config    Server configuration
   * @param onConnected  Optional async callback invoked after each successful
   *                     connect (e.g. to rebuild the eval tool).
   */
  connectServerInBackground(
    name: string,
    config: MCPServerConfig,
    onConnected?: () => Promise<void>
  ): void {
    // Cancel any existing pending retry for this server
    this.cancelPendingRetry(name);

    const maxAttempts = config.maxRetries ?? 5;

    const connectionInfo: ServerConnectionInfo = {
      state: 'connecting',
      attempt: 0,
      maxAttempts,
    };
    this.connectionInfos.set(name, connectionInfo);

    const attemptConnect = async (attempt: number): Promise<void> => {
      connectionInfo.attempt = attempt;
      connectionInfo.state = 'connecting';
      connectionInfo.error = undefined;
      connectionInfo.nextRetryAt = undefined;

      let connectError: Error | undefined;
      try {
        await this.tryConnect(name, config);
      } catch (error) {
        connectError = error instanceof Error ? error : new Error(String(error));
      }

      if (!connectError) {
        connectionInfo.state = 'connected';
        logInfo(`Background connect to "${name}" succeeded`, { component: 'ServerManager' });
        if (onConnected) {
          try {
            await onConnected();
          } catch (e) {
            logError(
              `onConnected callback failed for "${name}"`,
              e instanceof Error ? e : { error: String(e) }
            );
          }
        }
        return;
      }

      // Check for OAuth-related failure — no retries
      const errMsg = connectError.message;
      if (config.oauth && /authorization timeout|oauth/i.test(errMsg)) {
        connectionInfo.state = 'awaiting-auth';
        connectionInfo.error = 'OAuth authorization required';
        logWarn(
          `Server "${name}" requires OAuth authorization — not retrying`,
          { component: 'ServerManager', error: errMsg }
        );
        return;
      }

      // Non-OAuth failure: retry with backoff
      if (attempt + 1 >= maxAttempts) {
        connectionInfo.state = 'failed';
        connectionInfo.error = `Failed after ${attempt + 1} attempt${attempt + 1 !== 1 ? 's' : ''}`;
        logError(
          `Background connect to "${name}" failed after ${attempt + 1} attempt${attempt + 1 !== 1 ? 's' : ''}`,
          connectError
        );
        return;
      }

      const delay =
        Math.min(1000 * Math.pow(2, attempt), 30000) +
        Math.floor(Math.random() * 1000);
      connectionInfo.nextRetryAt = new Date(Date.now() + delay);

      logWarn(
        `Connect to "${name}" failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${Math.round(delay / 1000)}s`,
        { component: 'ServerManager', error: errMsg }
      );

      const timer = setTimeout(() => {
        this.retryTimers.delete(name);
        void attemptConnect(attempt + 1);
      }, delay);
      this.retryTimers.set(name, timer);
    };

    void attemptConnect(0);
  }

  /**
   * Cancel any pending background-retry timer for the named server.
   */
  private cancelPendingRetry(name: string): void {
    const timer = this.retryTimers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(name);
    }
  }

  /**
   * Return a snapshot of all tracked server connection states, including
   * servers still connecting or failed.
   */
  getConnectionStates(): Record<string, ServerConnectionInfo> {
    const result: Record<string, ServerConnectionInfo> = {};
    for (const [name, info] of this.connectionInfos.entries()) {
      result[name] = { ...info };
    }
    return result;
  }

  /**
   * Register a virtual server directly with pre-built ToolDescriptors.
   * No upstream MCP connection is established — useful for built-in utility
   * tools that run in-process (e.g. the `utils` server).
   */
  public registerServer(
    name: string,
    tools: Record<string, ToolDescriptor>
  ): void {
    this.servers.set(name, {
      name,
      config: { type: 'stdio', command: '', args: [] } as any, // sentinel — no real connection
      client: null,
      tools,
    });
    logInfo(`Registered virtual server "${name}" (${Object.keys(tools).length} tool${Object.keys(tools).length !== 1 ? 's' : ''})`, { component: 'ServerManager' });
  }

  /**
   * Disconnect from a single upstream server and remove it from the registry.
   * Also cancels any pending background-retry timer for this server.
   */
  async disconnectServer(name: string): Promise<void> {
    // Cancel any pending retry before removing
    this.cancelPendingRetry(name);
    this.connectionInfos.delete(name);

    const managed = this.servers.get(name);
    if (!managed) return;

    try {
      await managed.client?.close();
    } catch (error) {
      logDebug(
        `Error closing client for "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { component: 'ServerManager' }
      );
    }

    this.servers.delete(name);
    logInfo(`Disconnected from "${name}"`, { component: 'ServerManager' });
  }

  /**
   * Disconnect all connected servers and cancel all pending retries.
   */
  async disconnectAll(): Promise<void> {
    // Cancel all pending retry timers first
    for (const name of this.retryTimers.keys()) {
      this.cancelPendingRetry(name);
    }
    const names = Array.from(this.servers.keys());
    await Promise.all(names.map((n) => this.disconnectServer(n)));
  }

  /**
   * Merge all server tool descriptors into a single flat object.
   * The shape is exactly what createCodeTool() expects.
   */
  getAllToolDescriptors(): Record<string, ToolDescriptor> {
    const result: Record<string, ToolDescriptor> = {};
    for (const managed of this.servers.values()) {
      Object.assign(result, managed.tools);
    }
    return result;
  }

  /**
   * Return the names of all currently-connected servers.
   */
  getConnectedServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Return tool-count info grouped by server (for the status tool).
   */
  getServerToolInfo(): Array<{ name: string; toolCount: number; tools: string[] }> {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      toolCount: Object.keys(s.tools).length,
      tools: Object.keys(s.tools),
    }));
  }

  /**
   * Look up a single tool descriptor by its name as returned by getToolList()
   * (the sanitized callable form, e.g. "gitlab__list_projects").
   * Returns undefined if no tool with that name is registered.
   */
  getToolByName(name: string): ToolDescriptor | undefined {
    for (const managed of this.servers.values()) {
      for (const [namespacedName, descriptor] of Object.entries(managed.tools)) {
        if (sanitizeToolName(namespacedName) === name) {
          return descriptor;
        }
      }
    }
    return undefined;
  }

  /**
   * Return a flat list of all tools, optionally filtered by server name.
   * Each entry includes the server name, the sanitized callable name
   * (as used in eval code), and the tool description.
   */
  getToolList(
    serverName?: string
  ): Array<{ server: string; name: string; description: string }> {
    const results: Array<{ server: string; name: string; description: string }> = [];

    for (const managed of this.servers.values()) {
      if (serverName !== undefined && managed.name !== serverName) {
        continue;
      }
      for (const [namespacedName, descriptor] of Object.entries(managed.tools)) {
        results.push({
          server: managed.name,
          name: sanitizeToolName(namespacedName),
          description: descriptor.description,
        });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildDescriptor(
    toolDef: MCPTool,
    client: MCPClient,
    toolName: string,
    serverName: string
  ): ToolDescriptor {
    const rawSchema = toolDef.inputSchema ?? {};
    return {
      description: toolDef.description || "",
      inputSchema: jsonSchemaToZod(toolDef.inputSchema),
      outputSchema: toolDef.outputSchema ? jsonSchemaToZod(toolDef.outputSchema) : undefined,
      rawSchema,
      execute: async (args: any) => {
        logDebug(`Calling tool: ${serverName}__${toolName}`, {
          component: 'Tool Execution',
          server: serverName,
          tool: toolName,
          args: JSON.stringify(args),
        });

        try {
          const result = await client.callTool(toolName, args);
          logDebug(`Tool completed: ${serverName}__${toolName}`, {
            component: 'Tool Execution',
            server: serverName,
            tool: toolName,
            resultType: typeof result,
            resultSize: JSON.stringify(result).length,
          });
          return result;
        } catch (error) {
          logDebug(`Tool failed: ${serverName}__${toolName}`, {
            component: 'Tool Execution',
            server: serverName,
            tool: toolName,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    };
  }
}
