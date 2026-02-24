/**
 * MCP Client - Wrapper around official MCP SDK for connecting to upstream MCP servers
 * 
 * This client:
 * 1. Uses the official @modelcontextprotocol/sdk Client API
 * 2. Supports stdio, HTTP (Streamable HTTP), and SSE transports
 * 3. Returns tools in native MCP format (JSON Schema for inputSchema)
 * 4. Provides tool execution via callTool()
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Configuration for an MCP server to connect to upstream
 */
export interface MCPServerConfig {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/**
 * MCP Tool definition in native format
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any; // JSON Schema
}

/**
 * MCP Client wrapper using official SDK
 */
export class MCPClient {
  private client: Client;
  private transport: Transport | null = null;
  private connected: boolean = false;

  constructor(private config: MCPServerConfig) {
    this.client = new Client(
      {
        name: `codemode-bridge-client-${config.name}`,
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
  }

  /**
   * Connect to the upstream MCP server
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.config.type === "stdio") {
      if (!this.config.command) {
        throw new Error(`stdio type requires "command" field`);
      }

      // Merge provided env vars with current process env, filtering out undefined values
      const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<[string, string]>
      );
      const env = this.config.env ? { ...baseEnv, ...this.config.env } : baseEnv;

      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env,
      });

      await this.client.connect(this.transport);
      this.connected = true;
    } else if (this.config.type === "http") {
      if (!this.config.url) {
        throw new Error(`http type requires "url" field`);
      }

      // Create HTTP transport using Streamable HTTP
      this.transport = new StreamableHTTPClientTransport(new URL(this.config.url));

      await this.client.connect(this.transport);
      this.connected = true;
    } else if (this.config.type === "sse") {
      if (!this.config.url) {
        throw new Error(`sse type requires "url" field`);
      }

      // Create SSE transport (deprecated but still supported)
      this.transport = new SSEClientTransport(new URL(this.config.url));

      await this.client.connect(this.transport);
      this.connected = true;
    } else {
      throw new Error(`Unsupported transport type: ${this.config.type}`);
    }
  }

  /**
   * List all tools from the upstream server
   * Returns tools in native MCP format with JSON Schema
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.connected) {
      throw new Error("Client not connected. Call connect() first.");
    }

    const response = await this.client.listTools();
    return response.tools;
  }

  /**
   * Call a tool on the upstream server
   */
  async callTool(name: string, args: any): Promise<any> {
    if (!this.connected) {
      throw new Error("Client not connected. Call connect() first.");
    }

    const response = await this.client.callTool({
      name,
      arguments: args,
    });

    return response;
  }

  /**
   * Close the connection to the upstream server
   */
  async close(): Promise<void> {
    if (this.connected && this.client) {
      await this.client.close();
      this.connected = false;
    }
  }
}
