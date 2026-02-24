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

/**
 * Run the bridge server
 */
export async function runServer(
  configPath?: string,
  servers?: string[]
): Promise<void> {
  try {
    console.error(chalk.cyan("\n🚀 Code Mode Bridge"));
    console.error(chalk.cyan("====================\n"));

    // Load the bridge configuration
    const bridgeConfig = loadConfig(configPath);
    console.error(
      chalk.green("✓") +
        ` Loaded config from: ${getConfigFilePath(configPath)}`
    );
    console.error(
      chalk.green("✓") +
        ` Found ${Object.keys(bridgeConfig.servers).length} configured servers\n`
    );

    // Determine which servers to connect to
    let serverNames: string[] = [];

    if (servers && servers.length > 0) {
      serverNames = servers;
      console.error(chalk.blue("📡") + ` Loading servers: ${serverNames.join(", ")}`);
    } else if (Object.keys(bridgeConfig.servers).length > 0) {
      serverNames = Object.keys(bridgeConfig.servers);
      console.error(
        chalk.yellow("ℹ") +
          ` No servers specified, loading all configured servers: ${serverNames.join(", ")}`
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
        console.error(chalk.green("✓") + ` Loaded ${serverName}`);
      } catch (err) {
        console.error(
          chalk.red("✗") +
            ` Failed to load ${serverName}: ${(err as Error).message}`
        );
        process.exit(1);
      }
    }

    console.error(
      chalk.green("✓") +
        ` Starting bridge with ${serverConfigs.length} server(s)\n`
    );

    // Start the MCP bridge server
    await startCodeModeBridgeServer(serverConfigs);

    console.error(chalk.green("✓") + " Bridge is running!");
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
