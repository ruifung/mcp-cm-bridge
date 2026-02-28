/**
 * ServerManager - manages the lifecycle of upstream MCP server connections.
 *
 * Encapsulates the connect / disconnect / list-tools logic that was previously
 * inlined in startCodeModeBridgeServer().  ServerManager keeps a registry of
 * currently-connected servers and exposes a flat view of all their tools for
 * use by the eval-tool builder.
 */

import { MCPClient, type MCPServerConfig, type MCPTool } from "./mcp-client.js";
import { logDebug, logError, logInfo } from "../utils/logger.js";
import { sanitizeToolName, jsonSchemaToZod } from "./schema-utils.js";

/**
 * A single upstream server connection with its resolved tools.
 */
export interface ManagedServer {
  name: string;
  config: MCPServerConfig;
  client: MCPClient;
  /** Namespaced tool descriptors keyed by "<serverName>__<toolName>" */
  tools: Record<string, ToolDescriptor>;
}

/**
 * A tool descriptor ready to be passed to createCodeTool().
 */
export interface ToolDescriptor {
  description: string;
  inputSchema: any; // Zod schema
  /** Original JSON Schema from the upstream MCP server, before Zod conversion. */
  rawSchema: any;
  execute: (args: any) => Promise<any>;
}

export class ServerManager {
  private servers = new Map<string, ManagedServer>();

  /**
   * Connect to a single upstream MCP server, list its tools, and register
   * them in the internal map.  If the connection fails, a warning is logged
   * and the server is skipped (does NOT throw).
   */
  async connectServer(name: string, config: MCPServerConfig): Promise<boolean> {
    try {
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
   * Disconnect from a single upstream server and remove it from the registry.
   */
  async disconnectServer(name: string): Promise<void> {
    const managed = this.servers.get(name);
    if (!managed) return;

    try {
      await managed.client.close();
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
   * Disconnect all connected servers.
   */
  async disconnectAll(): Promise<void> {
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
