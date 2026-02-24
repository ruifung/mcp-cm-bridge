/**
 * CLI Commands for Code Mode Bridge
 * 
 * Implements subcommands for managing and running the bridge
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import {
  loadConfig,
  saveConfig,
  addServer,
  removeServer,
  updateServer,
  getServer,
  listServers,
  validateServer,
  getDefaultConfigDir,
  getConfigFilePath,
} from "./config-manager.js";
import { startCodeModeBridgeServer, type MCPServerConfig } from "../mcp/server.js";
import { getServerConfig } from "../mcp/config.js";
import type { MCPServerConfigEntry, MCPJsonConfig } from "../mcp/config.js";
import { initializeLogger, logInfo, logError, flushStderrBuffer } from "../utils/logger.js";
import { tokenPersistence } from "../mcp/token-persistence.js";
import { MCPClient } from "../mcp/mcp-client.js";

/**
 * Run the bridge server
 */
export async function runServer(
  configPath?: string,
  servers?: string[],
  debug?: boolean
): Promise<void> {
  try {
    // Initialize logger with debug mode if requested
    initializeLogger(debug);

    console.error(chalk.cyan("\n🚀 Code Mode Bridge"));
    console.error(chalk.cyan("====================\n"));

    // Load the bridge configuration
    const bridgeConfig = loadConfig(configPath);
    logInfo(
      `Loaded config from: ${getConfigFilePath(configPath)}`,
      { component: 'CLI' }
    );
    logInfo(
      `Found ${Object.keys(bridgeConfig.servers).length} configured servers`,
      { component: 'CLI' }
    );

    // Determine which servers to connect to
    let serverNames: string[] = [];

    if (servers && servers.length > 0) {
      serverNames = servers;
      logInfo(`Loading servers: ${serverNames.join(", ")}`, { component: 'CLI' });
    } else if (Object.keys(bridgeConfig.servers).length > 0) {
      serverNames = Object.keys(bridgeConfig.servers);
      logInfo(
        `No servers specified, loading all configured servers: ${serverNames.join(", ")}`,
        { component: 'CLI' }
      );
    } else {
      console.error(
        chalk.yellow("ℹ") + " No servers configured\n"
      );
    }

    // Load server configurations
    const serverConfigs: MCPServerConfig[] = [];
    for (const serverName of serverNames) {
      try {
        const serverConfig = getServerConfig(bridgeConfig, serverName);
        serverConfigs.push(serverConfig);
        logInfo(`Loaded ${serverName}`, { component: 'CLI' });
      } catch (err) {
        logError(
          `Failed to load ${serverName}`,
          err instanceof Error ? err : { error: String(err) }
        );
        process.exit(1);
      }
    }

    logInfo(
      `Starting bridge with ${serverConfigs.length} server(s)`,
      { component: 'CLI' }
    );

    // Start the MCP bridge server
    await startCodeModeBridgeServer(serverConfigs);

    // Flush buffered stderr output from stdio tools now that Bridge is fully running
    flushStderrBuffer();

    logInfo("Bridge is running!", { component: 'CLI' });
  } catch (error) {
    logError(
      "Error",
      error instanceof Error ? error : { error: String(error) }
    );
    process.exit(1);
  }
}

/**
 * List all configured servers
 */
export function listServersCommand(configPath?: string): void {
  try {
    const config = loadConfig(configPath);
    const servers = listServers(config);

    if (servers.length === 0) {
      console.log(chalk.yellow("No servers configured.\n"));
      console.log(`To add a server, use:\n`);
      console.log(
        `  ${chalk.cyan(
          "codemode-bridge config add <name> --type stdio --command <command>"
        )}`
      );
      return;
    }

    console.log(chalk.cyan("\nConfigured Servers:") + "\n");

    for (const { name, entry } of servers) {
      console.log(chalk.bold(name));

      if (entry.type === "stdio") {
        console.log(`  Type:    ${chalk.blue(entry.type)}`);
        console.log(`  Command: ${entry.command}`);
        if (entry.args && entry.args.length > 0) {
          console.log(`  Args:    ${entry.args.join(" ")}`);
        }
      } else if (entry.type === "http") {
        console.log(`  Type:    ${chalk.blue(entry.type)}`);
        console.log(`  URL:     ${entry.url}`);
      }

      if (entry.env && Object.keys(entry.env).length > 0) {
        console.log(`  Env:     ${JSON.stringify(entry.env)}`);
      }

      console.log();
    }

    console.log(`Config file: ${chalk.gray(getConfigFilePath(configPath))}\n`);
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}

/**
 * Show a specific server configuration
 */
export function showServerCommand(name: string, configPath?: string): void {
  try {
    const config = loadConfig(configPath);
    const entry = getServer(config, name);

    if (!entry) {
      console.error(chalk.red("✗") + ` Server "${name}" not found`);
      process.exit(1);
    }

    console.log(chalk.cyan(`\nServer: ${name}\n`));
    console.log(JSON.stringify(entry, null, 2));
    console.log();
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}

/**
 * Add a new server configuration
 */
export function addServerCommand(
  name: string,
  options: {
    type: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  },
  configPath?: string
): void {
  try {
    const entry: MCPServerConfigEntry = {
      type: options.type as "stdio" | "http",
    };

    if (options.type === "stdio") {
      if (!options.command) {
        console.error(chalk.red("✗") + ' Missing --command for stdio server');
        process.exit(1);
      }
      entry.command = options.command;
      if (options.args) {
        entry.args = options.args;
      }
    } else if (options.type === "http") {
      if (!options.url) {
        console.error(chalk.red("✗") + ' Missing --url for http server');
        process.exit(1);
      }
      entry.url = options.url;
    } else {
      console.error(chalk.red("✗") + ` Invalid type: "${options.type}"`);
      process.exit(1);
    }

    if (options.env) {
      entry.env = options.env;
    }

    // Validate
    const validation = validateServer(entry);
    if (!validation.valid) {
      console.error(chalk.red("✗") + " Validation failed:");
      for (const error of validation.errors) {
        console.error("  " + error);
      }
      process.exit(1);
    }

    // Load, add, and save
    const config = loadConfig(configPath);
    addServer(config, name, entry);
    saveConfig(config, configPath);

    console.log(chalk.green("✓") + ` Added server "${name}"\n`);
    showServerCommand(name, configPath);
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}

/**
 * Remove a server configuration
 */
export function removeServerCommand(name: string, configPath?: string): void {
  try {
    const config = loadConfig(configPath);
    removeServer(config, name);
    saveConfig(config, configPath);

    console.log(chalk.green("✓") + ` Removed server "${name}"\n`);
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}

/**
 * Edit a server configuration
 */
export function editServerCommand(
  name: string,
  options: Partial<{
    type?: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }>,
  configPath?: string
): void {
  try {
    const config = loadConfig(configPath);
    const entry = getServer(config, name);

    if (!entry) {
      console.error(chalk.red("✗") + ` Server "${name}" not found`);
      process.exit(1);
    }

    // Update fields
    if (options.type) entry.type = options.type as "stdio" | "http";
    if (options.command) entry.command = options.command;
    if (options.args) entry.args = options.args;
    if (options.url) entry.url = options.url;
    if (options.env) entry.env = options.env;

    // Validate
    const validation = validateServer(entry);
    if (!validation.valid) {
      console.error(chalk.red("✗") + " Validation failed:");
      for (const error of validation.errors) {
        console.error("  " + error);
      }
      process.exit(1);
    }

    // Save
    updateServer(config, name, entry);
    saveConfig(config, configPath);

    console.log(chalk.green("✓") + ` Updated server "${name}"\n`);
    showServerCommand(name, configPath);
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}

/**
 * Show config file information
 */
export function configInfoCommand(configPath?: string): void {
  const filePath = getConfigFilePath(configPath);
  const dir = path.dirname(filePath);
  const exists = fs.existsSync(filePath);

  console.log(chalk.cyan("\nConfiguration Information\n"));
  console.log(`Config file:     ${chalk.bold(filePath)}`);
  console.log(`Directory:       ${chalk.bold(dir)}`);
  console.log(`Status:          ${exists ? chalk.green("exists") : chalk.yellow("will be created")}`);

  if (configPath) {
    console.log(`\n${chalk.yellow("ℹ")} Using custom config path`);
  } else {
  console.log(`\n${chalk.yellow("ℹ")} Using default config path`);
  }

  console.log();
}

/**
 * Login command for OAuth servers
 * 
 * Usage: codemode-bridge auth login <server-name>
 * 
 * Initiates OAuth flow by connecting to the server and opening the authorization URL in a browser.
 */
export async function authLoginCommand(serverName: string, configPath?: string): Promise<void> {
  try {
    // Initialize logger
    initializeLogger(false);

    // Load config and get server
    const config = loadConfig(configPath);
    const serverEntry = getServer(config, serverName);

    if (!serverEntry) {
      console.error(chalk.red("✗") + ` Server "${serverName}" not found`);
      process.exit(1);
    }

    // Check if server has OAuth configured
    if (!serverEntry.oauth) {
      console.error(chalk.red("✗") + ` Server "${serverName}" does not have OAuth configured`);
      process.exit(1);
    }

    // Only HTTP servers support OAuth
    if (serverEntry.type !== "http") {
      console.error(chalk.red("✗") + ` OAuth is only supported for HTTP servers (${serverName} is ${serverEntry.type})`);
      process.exit(1);
    }

    if (!serverEntry.url) {
      console.error(chalk.red("✗") + ` Server "${serverName}" is missing URL configuration`);
      process.exit(1);
    }

    console.log(chalk.cyan(`\nInitiating OAuth login for ${chalk.bold(serverName)}...\n`));

    // Get server config for MCP client
    const serverConfig = getServerConfig(config, serverName);

    // Create MCP client and initiate OAuth flow
    const client = new MCPClient(serverConfig);
    
    console.log(chalk.cyan("Connecting to server..."));
    await client.connect();

    console.log(chalk.green(`✓ Successfully authenticated to ${serverName}`));
    console.log(chalk.cyan(`\nTokens have been saved for future use.\n`));

  } catch (error) {
    logError(
      `Failed to complete OAuth login for ${serverName}`,
      error instanceof Error ? error : { error: String(error) }
    );
    console.error(chalk.red("\n✗ OAuth login failed"));
    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }
    process.exit(1);
  }
}

/**
 * Logout command for OAuth servers
 * 
 * Usage: codemode-bridge auth logout <server-name>
 * 
 * Clears all stored authentication data (tokens and client info) for the server.
 */
export function authLogoutCommand(serverName: string, configPath?: string): void {
  try {
    // Load config and get server
    const config = loadConfig(configPath);
    const serverEntry = getServer(config, serverName);

    if (!serverEntry) {
      console.error(chalk.red("✗") + ` Server "${serverName}" not found`);
      process.exit(1);
    }

    // Check if server has OAuth configured
    if (!serverEntry.oauth) {
      console.error(chalk.red("✗") + ` Server "${serverName}" does not have OAuth configured`);
      process.exit(1);
    }

    // Get the server URL for token persistence
    let serverUrl: string;
    if (serverEntry.type === "http" && serverEntry.url) {
      serverUrl = serverEntry.url;
    } else {
      // For stdio servers, use server name as key
      serverUrl = serverName;
    }

    // Clear all auth data including client information
    tokenPersistence.clearAll(serverUrl);
    
    logInfo(`Cleared all authentication data for ${serverName}`, { component: 'CLI' });
    console.log(chalk.green(`✓ Logged out from ${serverName}`));
    console.log(chalk.cyan(`\nAll tokens and client information have been cleared.`));
  } catch (error) {
    logError(
      `Failed to logout from ${serverName}`,
      error instanceof Error ? error : { error: String(error) }
    );
    process.exit(1);
  }
}

/**
 * List command for OAuth servers
 * 
 * Usage: codemode-bridge auth list
 * 
 * Shows all OAuth-enabled servers and their authentication status.
 */
export function authListCommand(configPath?: string): void {
  try {
    // Load config
    const config = loadConfig(configPath);
    
    // Find all OAuth-enabled servers
    const oauthServers: Array<{
      name: string;
      entry: MCPServerConfigEntry;
      serverUrl: string;
      status: 'authenticated' | 'expired' | 'needs login';
    }> = [];

    for (const [name, entry] of Object.entries(config.servers || {})) {
      if (entry.oauth) {
        // Determine server URL for token lookup
        let serverUrl: string;
        if (entry.type === "http" && entry.url) {
          serverUrl = entry.url;
        } else {
          serverUrl = name;
        }

        // Get token status
        const tokenStatus = tokenPersistence.getTokenStatus(serverUrl);
        let status: 'authenticated' | 'expired' | 'needs login';
        if (tokenStatus.exists && !tokenStatus.isExpired) {
          status = 'authenticated';
        } else if (tokenStatus.exists && tokenStatus.isExpired) {
          status = 'expired';
        } else {
          status = 'needs login';
        }

        oauthServers.push({
          name,
          entry,
          serverUrl,
          status,
        });
      }
    }

    // Display results
    if (oauthServers.length === 0) {
      console.log(chalk.yellow("No OAuth-enabled servers configured.\n"));
      return;
    }

    console.log(chalk.cyan("\nOAuth Servers:\n"));

    for (const server of oauthServers) {
      const name = chalk.bold(server.name);
      
      let statusColor: (text: string) => string;
      switch (server.status) {
        case 'authenticated':
          statusColor = chalk.green;
          break;
        case 'expired':
          statusColor = chalk.yellow;
          break;
        default:
          statusColor = chalk.gray;
      }

      console.log(`${name} (${server.entry.type})${chalk.dim(` - ${statusColor(server.status)}`)}`);
    }

    console.log();
  } catch (error) {
    console.error(
      chalk.red("✗") +
        " Error: " +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  }
}
