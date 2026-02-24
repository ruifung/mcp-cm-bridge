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
import { tokenPersistence } from "./token-persistence.js";
import { logDebug } from "../utils/logger.js";

/**
 * OAuth2 configuration for HTTP/SSE transports
 */
export interface OAuth2Config {
  /** 
   * OAuth client ID (optional for dynamic registration).
   * If not provided, the client will attempt dynamic registration with the server.
   */
  clientId?: string;
  /** OAuth client secret (optional for public clients) */
  clientSecret?: string;
  /** 
   * OAuth redirect URL for authorization flow.
   * Defaults to "http://localhost:3000/oauth/callback" if not provided.
   */
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
 * Supports both pre-registered clients and dynamic client registration (RFC 7591)
 */
class SimpleOAuthProvider implements OAuthClientProvider {
  private static readonly DEFAULT_REDIRECT_URL = 'http://localhost:3000/oauth/callback';
  
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _clientInfo?: OAuthClientInformationMixed;
  private _discoveryState?: OAuthDiscoveryState;

  constructor(private config: OAuth2Config, private serverUrl: string) {
    logDebug(`Creating provider for ${serverUrl}`, { component: 'OAuth' });
    
    // Load tokens from persistence on initialization
    const persistedTokens = tokenPersistence.getTokens(serverUrl);
    if (persistedTokens) {
      this._tokens = persistedTokens;
      logDebug(`Loaded persisted tokens for ${serverUrl}`, { component: 'OAuth' });
    } else {
      logDebug(`No persisted tokens found for ${serverUrl}`, { component: 'OAuth' });
    }
    
    // Load client information from persistence
    const persistedClientInfo = tokenPersistence.getClientInformation(serverUrl);
    if (persistedClientInfo) {
      this._clientInfo = persistedClientInfo;
      logDebug(`Loaded persisted client info for ${serverUrl}`, { component: 'OAuth' });
    } else {
      logDebug(`No persisted client info found for ${serverUrl}`, { component: 'OAuth' });
    }
  }

  get redirectUrl(): string | URL | undefined {
    return this.config.redirectUrl || SimpleOAuthProvider.DEFAULT_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.config.redirectUrl || SimpleOAuthProvider.DEFAULT_REDIRECT_URL;
    const metadata: OAuthClientMetadata = {
      redirect_uris: [redirectUrl],
      client_name: 'CodeMode Bridge',
    };

    if (this.config.grantType) {
      metadata.grant_types = [this.config.grantType];
    }

    return metadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // If client info was dynamically registered and saved, return it
    if (this._clientInfo) {
      return this._clientInfo;
    }

    // If clientId was provided in config (pre-registered), return static info
    if (this.config.clientId) {
      const info: OAuthClientInformationMixed = {
        client_id: this.config.clientId,
      };
      if (this.config.clientSecret) {
        info.client_secret = this.config.clientSecret;
      }
      return info;
    }

    // Return undefined to trigger dynamic registration
    return undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    // Save dynamically registered client information in memory
    this._clientInfo = clientInformation;
    // Also persist to disk
    tokenPersistence.saveClientInformation(this.serverUrl, clientInformation);
    logDebug(`Client dynamically registered: ${clientInformation.client_id}`, { component: 'OAuth' });
  }

  tokens(): OAuthTokens | undefined {
    // First try in-memory tokens
    if (this._tokens) {
      logDebug('tokens() returning in-memory tokens', { component: 'OAuth' });
      return this._tokens;
    }
    
    // Fallback to persistence if memory is empty
    logDebug('tokens() checking persistence...', { component: 'OAuth' });
    const persistedTokens = tokenPersistence.getTokens(this.serverUrl);
    if (persistedTokens) {
      this._tokens = persistedTokens;
      logDebug(`tokens() returning persisted tokens for ${this.serverUrl}`, { component: 'OAuth' });
      return persistedTokens;
    }
    
    logDebug('tokens() returning undefined - no tokens available', { component: 'OAuth' });
    return undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    logDebug(`saveTokens() called for ${this.serverUrl}`, { component: 'OAuth' });
    this._tokens = tokens;
    // Also persist tokens to disk
    tokenPersistence.saveTokens(this.serverUrl, tokens);
    logDebug('Tokens saved to persistence', { component: 'OAuth' });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const { open } = require('open');
    
    logDebug('=== OAuth Authorization Required ===', { component: 'OAuth' });
    logDebug(`Server: ${this.serverUrl}`, { component: 'OAuth' });
    logDebug('Opening browser for authorization...', { component: 'OAuth' });
    logDebug(`URL: ${authorizationUrl.toString()}`, { component: 'OAuth' });
    
    // Open in default browser
    open(authorizationUrl.toString()).catch((err: Error) => {
      logDebug('Could not open browser automatically.', { component: 'OAuth' });
      logDebug('Please visit this URL to authorize:', { component: 'OAuth' });
      logDebug(authorizationUrl.toString(), { component: 'OAuth' });
    });
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
    if (config.oauth && config.url) {
      this.oauthProvider = new SimpleOAuthProvider(config.oauth, config.url);
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

      // Set stderr to 'inherit' so it goes to parent's stderr (will be captured by our logger)
      // This allows stdio tools to output debug info that will be visible
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env,
        stderr: 'inherit',
      });

      await this.client.connect(this.transport);
      this.connected = true;
    } else if (this.config.type === "http") {
      if (!this.config.url) {
        throw new Error(`http type requires "url" field`);
      }

      // Create HTTP transport using Streamable HTTP with optional OAuth
      if (this.oauthProvider) {
        logDebug(`Connecting with OAuth provider to ${this.config.url}`, { component: 'HTTP' });
        const currentTokens = this.oauthProvider.tokens();
        if (currentTokens) {
          logDebug('OAuth tokens available', { component: 'HTTP' });
        } else {
          logDebug('WARNING: No OAuth tokens available', { component: 'HTTP' });
        }
      } else {
        logDebug(`Connecting without OAuth to ${this.config.url}`, { component: 'HTTP' });
      }

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

    logDebug(`Invoking upstream tool: ${name}`, {
      component: 'MCP Client',
      transport: this.config.type,
      server: this.config.name,
      argsSize: JSON.stringify(args).length
    });

    try {
      const response = await this.client.callTool({
        name,
        arguments: args,
      });

      logDebug(`Upstream tool completed: ${name}`, {
        component: 'MCP Client',
        transport: this.config.type,
        server: this.config.name,
        resultType: typeof response
      });

      return response;
    } catch (error) {
      logDebug(`Upstream tool failed: ${name}`, {
        component: 'MCP Client',
        transport: this.config.type,
        server: this.config.name,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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
