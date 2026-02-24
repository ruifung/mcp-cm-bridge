/**
 * Configuration Manager for Code Mode Bridge
 * 
 * Manages the bridge configuration stored in .config/codemode-bridge/mcp.json
 * Provides utilities to load, save, and manipulate the configuration
 */

import * as fs from "fs";
import * as path from "path";
import type { MCPJsonConfig, MCPServerConfigEntry } from "../mcp/config.js";

/**
 * Get the default config directory for the current platform
 */
export function getDefaultConfigDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();

  if (process.platform === "win32") {
    return path.join(homeDir, ".config", "codemode-bridge");
  } else if (process.platform === "darwin") {
    return path.join(homeDir, ".config", "codemode-bridge");
  } else {
    // Linux
    return path.join(homeDir, ".config", "codemode-bridge");
  }
}

/**
 * Get the full path to the mcp.json config file
 */
export function getConfigFilePath(overridePath?: string): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  return path.join(getDefaultConfigDir(), "mcp.json");
}

/**
 * Load the configuration file, creating it if it doesn't exist
 */
export function loadConfig(configPath?: string): MCPJsonConfig {
  const filePath = getConfigFilePath(configPath);

  if (!fs.existsSync(filePath)) {
    // Create default config
    const defaultConfig: MCPJsonConfig = {
      servers: {},
    };
    saveConfig(defaultConfig, configPath);
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as MCPJsonConfig;
  } catch (error) {
    throw new Error(
      `Failed to parse config file at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Save the configuration file
 */
export function saveConfig(config: MCPJsonConfig, configPath?: string): void {
  const filePath = getConfigFilePath(configPath);
  const dir = path.dirname(filePath);

  // Create directory if it doesn't exist
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to save config file at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Add a server to the configuration
 */
export function addServer(
  config: MCPJsonConfig,
  name: string,
  entry: MCPServerConfigEntry
): MCPJsonConfig {
  if (config.servers[name]) {
    throw new Error(`Server "${name}" already exists`);
  }

  config.servers[name] = entry;
  return config;
}

/**
 * Remove a server from the configuration
 */
export function removeServer(config: MCPJsonConfig, name: string): MCPJsonConfig {
  if (!config.servers[name]) {
    throw new Error(`Server "${name}" not found`);
  }

  delete config.servers[name];
  return config;
}

/**
 * Update a server in the configuration
 */
export function updateServer(
  config: MCPJsonConfig,
  name: string,
  entry: MCPServerConfigEntry
): MCPJsonConfig {
  if (!config.servers[name]) {
    throw new Error(`Server "${name}" not found`);
  }

  config.servers[name] = entry;
  return config;
}

/**
 * Get a server from the configuration
 */
export function getServer(config: MCPJsonConfig, name: string): MCPServerConfigEntry | null {
  return config.servers[name] || null;
}

/**
 * List all servers in the configuration
 */
export function listServers(config: MCPJsonConfig): { name: string; entry: MCPServerConfigEntry }[] {
  return Object.entries(config.servers).map(([name, entry]) => ({
    name,
    entry,
  }));
}

/**
 * Validate a server configuration entry
 */
export function validateServer(entry: MCPServerConfigEntry): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!entry.type) {
    errors.push("Missing 'type' field (must be 'stdio' or 'http')");
  } else if (entry.type !== "stdio" && entry.type !== "http") {
    errors.push(`Invalid type: "${entry.type}" (must be 'stdio' or 'http')`);
  }

  if (entry.type === "stdio") {
    if (!entry.command) {
      errors.push("Missing 'command' field for stdio server");
    }
  } else if (entry.type === "http") {
    if (!entry.url) {
      errors.push("Missing 'url' field for http server");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
