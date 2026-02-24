/**
 * Config Loader - Load MCP server configurations from files
 * Supports VS Code's mcp.json format and other config files
 */

import * as fs from "fs";
import * as path from "path";
import type { MCPServerConfig } from "./server.js";

export interface MCPJsonConfig {
  servers: Record<string, MCPServerConfigEntry>;
  [key: string]: unknown;
}

export interface MCPServerConfigEntry {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Load MCP server configurations from VS Code's mcp.json file
 * Default location: ~/.config/Code/User/mcp.json (Linux/Mac) or
 *                   %APPDATA%\Code\User\mcp.json (Windows)
 */
export function loadMCPConfigFile(configPath?: string): MCPJsonConfig {
  let resolvedPath = configPath;

  if (!resolvedPath) {
    // Determine default config path based on platform
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();

    if (process.platform === "win32") {
      resolvedPath = path.join(homeDir, "AppData", "Roaming", "Code", "User", "mcp.json");
    } else if (process.platform === "darwin") {
      resolvedPath = path.join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
    } else {
      // Linux and others
      resolvedPath = path.join(homeDir, ".config", "Code", "User", "mcp.json");
    }
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`MCP config file not found at: ${resolvedPath}`);
  }

  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    return JSON.parse(content) as MCPJsonConfig;
  } catch (error) {
    throw new Error(`Failed to parse MCP config file at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get a list of all configured server names from the config file
 */
export function getServerNames(config: MCPJsonConfig): string[] {
  return Object.keys(config.servers || {});
}

/**
 * Get a server configuration by name
 */
export function getServerConfig(config: MCPJsonConfig, serverName: string): MCPServerConfig {
  const entry = config.servers?.[serverName];

  if (!entry) {
    throw new Error(`Server "${serverName}" not found in MCP config`);
  }

  // Convert from config entry to MCPServerConfig
  const serverConfig: MCPServerConfig = {
    name: serverName,
    type: entry.type,
  };

   if (entry.type === "stdio") {
     if (!entry.command) {
       throw new Error(`Server "${serverName}" of type "stdio" requires "command" field`);
     }
     serverConfig.command = entry.command;
     serverConfig.args = entry.args;
     serverConfig.env = entry.env;
   } else if (entry.type === "http") {
     if (!entry.url) {
       throw new Error(`Server "${serverName}" of type "http" requires "url" field`);
     }
     serverConfig.url = entry.url;
   }

  return serverConfig;
}

/**
 * Get multiple server configs by name from the config file
 */
export function getServerConfigs(config: MCPJsonConfig, serverNames: string[]): MCPServerConfig[] {
  return serverNames.map((name) => getServerConfig(config, name));
}

/**
 * Load and return all healthy servers from the config
 * (filters out offline servers based on availability checks)
 */
export async function loadAvailableServers(
  config: MCPJsonConfig,
  serverNames?: string[]
): Promise<{ available: MCPServerConfig[]; unavailable: string[] }> {
  const names = serverNames || getServerNames(config);
  const available: MCPServerConfig[] = [];
  const unavailable: string[] = [];

  for (const name of names) {
    try {
      const serverConfig = getServerConfig(config, name);
      available.push(serverConfig);
    } catch {
      unavailable.push(name);
    }
  }

  return { available, unavailable };
}
