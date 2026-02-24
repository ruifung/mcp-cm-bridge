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
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * OAuth2 configuration for HTTP/SSE transports
 */
export interface OAuth2Config {
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret (optional for public clients) */
  clientSecret?: string;
  /** OAuth redirect URL for authorization flow */
  redirectUrl?: string;
  /** OAuth scopes to request */
  scope?: string;
  /** Grant type: 'authorization_code' or 'client_credentials' */
  grantType?: 'authorization_code' | 'client_credentials';
}

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
  /** OAuth2 configuration (only for http/sse transports) */
  oauth?: OAuth2Config;
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
 * Simple in-memory OAuth provider implementation for basic OAuth flows
 */
class SimpleOAuthProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _clientInfo?: OAuthClientInformationMixed;
  private _discoveryState?: OAuthDiscoveryState;

  constructor(private config: OAuth2Config) {}

  get redirectUrl(): string | URL | undefined {
    return this.config.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: this.config.redirectUrl ? [this.config.redirectUrl] : [],
      client_name: 'CodeMode Bridge',
    };

    if (this.config.grantType) {
      metadata.grant_types = [this.config.grantType];
    }

    return metadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (!this._clientInfo) {
      this._clientInfo = {
        client_id: this.config.clientId,
      };
      if (this.config.clientSecret) {
        this._clientInfo.client_secret = this.config.clientSecret;
      }
    }
    return this._clientInfo;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this._clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    console.log('\n=== OAuth Authorization Required ===');
    console.log('Please visit this URL to authorize:');
    console.log(authorizationUrl.toString());
    console.log('====================================\n');
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('Code verifier not available');
    }
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._discoveryState;
  }

  // Prepare token request for client_credentials grant
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.config.grantType === 'client_credentials') {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
      });
      if (scope || this.config.scope) {
        params.set('scope', scope || this.config.scope!);
      }
      return params;
    }
    return undefined;
  }
}

/**
 * MCP Client wrapper using official SDK
 */
export class MCPClient {
  private client: Client;
  private transport: Transport | null = null;
  private connected: boolean = false;
  private oauthProvider?: OAuthClientProvider;

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

    // Create OAuth provider if config is present
    if (config.oauth) {
      this.oauthProvider = new SimpleOAuthProvider(config.oauth);
    }
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

      // Create HTTP transport using Streamable HTTP with optional OAuth
      this.transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        this.oauthProvider ? { authProvider: this.oauthProvider } : undefined
      );

      await this.client.connect(this.transport);
      this.connected = true;
    } else if (this.config.type === "sse") {
      if (!this.config.url) {
        throw new Error(`sse type requires "url" field`);
      }

      // Create SSE transport (deprecated but still supported) with optional OAuth
      this.transport = new SSEClientTransport(
        new URL(this.config.url),
        this.oauthProvider ? { authProvider: this.oauthProvider } : undefined
      );

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
