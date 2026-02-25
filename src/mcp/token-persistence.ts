/**
 * OAuth2 Token Storage
 * 
 * Persists OAuth tokens and client information to disk for reuse across sessions.
 * Stored in ~/.config/codemode-bridge/mcp-tokens.json
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

interface StoredAuthInfo {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  lastUpdated: number;
}

interface TokenStorage {
  [serverUrl: string]: StoredAuthInfo;
}

/**
 * Manages OAuth token storage for MCP server connections
 */
export class TokenPersistence {
  private configDir: string;
  private tokenFile: string;
  private storage: TokenStorage = {};

  constructor() {
    this.configDir = join(homedir(), '.config', 'codemode-bridge');
    this.tokenFile = join(this.configDir, 'mcp-tokens.json');
    this.loadStorage();
  }

  /**
   * Load tokens from disk
   */
  private loadStorage(): void {
    try {
      if (existsSync(this.tokenFile)) {
        const content = readFileSync(this.tokenFile, 'utf-8');
        this.storage = JSON.parse(content);
      }
    } catch (error) {
      console.warn('Failed to load token storage:', error);
      this.storage = {};
    }
  }

  /**
   * Save storage to disk
   */
  private saveStorage(): void {
    try {
      // Ensure directory exists
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }

      // Write tokens file
      writeFileSync(this.tokenFile, JSON.stringify(this.storage, null, 2));
    } catch (error) {
      console.warn('Failed to save token storage:', error);
    }
  }

  /**
   * Get stored client information for a server
   */
  getClientInformation(serverUrl: string): OAuthClientInformationMixed | undefined {
    return this.storage[serverUrl]?.clientInformation;
  }

  /**
   * Save client information for a server
   */
  saveClientInformation(serverUrl: string, clientInfo: OAuthClientInformationMixed): void {
    if (!this.storage[serverUrl]) {
      this.storage[serverUrl] = { lastUpdated: Date.now() };
    }
    this.storage[serverUrl].clientInformation = clientInfo;
    this.storage[serverUrl].lastUpdated = Date.now();
    this.saveStorage();
  }

  /**
   * Get stored tokens for a server
   */
  getTokens(serverUrl: string): OAuthTokens | undefined {
    const info = this.storage[serverUrl];
    if (!info?.tokens) {
      return undefined;
    }

    // Check if tokens have expired
    const tokens = info.tokens;
    const expiresAt = info.lastUpdated + ((tokens.expires_in || 3600) * 1000);
    if (expiresAt < Date.now()) {
      // Tokens expired - don't return them
      // The OAuth provider will request new ones
      delete info.tokens;
      this.saveStorage();
      return undefined;
    }

    return tokens;
  }

  /**
   * Save tokens for a server
   */
  saveTokens(serverUrl: string, tokens: OAuthTokens): void {
    if (!this.storage[serverUrl]) {
      this.storage[serverUrl] = { lastUpdated: Date.now() };
    }
    this.storage[serverUrl].tokens = tokens;
    this.storage[serverUrl].lastUpdated = Date.now();
    this.saveStorage();
  }

  /**
   * Clear all tokens for a server (useful when revoked)
   */
  clearTokens(serverUrl: string): void {
    if (this.storage[serverUrl]) {
      delete this.storage[serverUrl].tokens;
      this.saveStorage();
    }
  }

   /**
    * Clear all information for a server
    */
   clearAll(serverUrl: string): void {
     delete this.storage[serverUrl];
     this.saveStorage();
   }

   /**
    * Check if a server has stored tokens (and whether they're expired)
    * Returns { exists: boolean, isExpired: boolean }
    */
   getTokenStatus(serverUrl: string): { exists: boolean; isExpired: boolean } {
     const info = this.storage[serverUrl];
     if (!info?.tokens) {
       return { exists: false, isExpired: false };
     }

     const tokens = info.tokens;
     const expiresAt = info.lastUpdated + ((tokens.expires_in || 3600) * 1000);
     const isExpired = expiresAt < Date.now();

     return { exists: true, isExpired };
   }
}

// Singleton instance
export const tokenPersistence = new TokenPersistence();
