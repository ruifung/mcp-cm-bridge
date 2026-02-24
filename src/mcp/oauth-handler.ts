/**
 * OAuth2 Authorization Handler
 * 
 * Implements a loopback HTTP server to handle OAuth2 redirect callbacks.
 * When user completes authorization on the OAuth provider, the browser redirects
 * to our loopback server with the authorization code, which we capture and use
 * to complete the authorization flow.
 */

import { createServer, Server } from 'http';
import { URL } from 'url';

/**
 * Loopback HTTP server that listens for OAuth2 redirect callbacks
 */
export class OAuthCallbackServer {
  private server?: Server;
  private port: number = 0; // 0 means OS will assign an available port
  private host: string = 'localhost';
  private pendingAuthorization?: {
    resolve: (code: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  };

  constructor(redirectUrl?: string) {
    // Parse redirect URL to extract host and port
    if (redirectUrl) {
      try {
        const url = new URL(redirectUrl);
        this.host = url.hostname || 'localhost';
        // If a specific port is provided in the URL, use it
        // Otherwise use 0 (OS will assign available port)
        this.port = url.port ? parseInt(url.port) : 0;
      } catch {
        this.port = 0;
      }
    } else {
      this.port = 0;
    }
  }

  /**
   * Start the callback server and wait for authorization code
   * Returns a promise that resolves when the authorization code is received
   * or rejects if timeout occurs or server fails to start
   */
  async waitForAuthorizationCode(timeoutMs: number = 300000): Promise<string> {
    return new Promise((resolve, reject) => {
      // Create HTTP server
      this.server = createServer((req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        if (error) {
          // OAuth error from authorization server
          const errorMsg = errorDescription 
            ? `${error}: ${errorDescription}` 
            : `OAuth error: ${error}`;
          
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Authorization Failed</h1>
                <p>${errorMsg}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);

          if (this.pendingAuthorization) {
            this.pendingAuthorization.reject(new Error(errorMsg));
          }
          return;
        }

        if (code) {
          // Success - authorization code received
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Authorization Successful</h1>
                <p>You have successfully authorized the Code Mode Bridge.</p>
                <p>You can close this window and return to your terminal.</p>
              </body>
            </html>
          `);

          if (this.pendingAuthorization) {
            this.pendingAuthorization.resolve(code);
          }
          return;
        }

        // Unknown request
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid OAuth callback request');
      });

      // Set up timeout
      const timeout = setTimeout(() => {
        reject(new Error(`Authorization timeout after ${timeoutMs}ms`));
        this.stop();
      }, timeoutMs);

      // Start listening on available port
      this.server!.listen(this.port, this.host, () => {
        // Get the actual port assigned by the OS (in case we used 0)
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        
        // Store the promise handlers for when request arrives
        this.pendingAuthorization = {
          resolve,
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
            this.stop();
          },
          timeout,
        };
      });

      this.server!.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Stop the callback server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = undefined;
          resolve();
        });
      });
    }
  }

  /**
   * Get the redirect URL for this server
   * After waitForAuthorizationCode is called, returns the actual URL with the assigned port
   */
  getRedirectUrl(): string {
    return `http://${this.host}:${this.port}/oauth/callback`;
  }
}
