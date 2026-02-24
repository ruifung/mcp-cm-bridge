#!/usr/bin/env node

/**
 * Code Mode Bridge CLI
 * 
 * Main entry point for the command-line interface
 * 
 * Usage:
 *   codemode-bridge run [options]            - Start the bridge server
 *   codemode-bridge config list [options]    - List configured servers
 *   codemode-bridge config show <name>       - Show a server configuration
 *   codemode-bridge config add <name>        - Add a new server
 *   codemode-bridge config remove <name>     - Remove a server
 *   codemode-bridge config edit <name>       - Edit a server
 *   codemode-bridge config info              - Show config file information
 *   codemode-bridge auth list [options]      - List OAuth-enabled servers and status
 *   codemode-bridge auth login <name>        - Prepare to login to an OAuth server
 *   codemode-bridge auth logout <name>       - Logout from an OAuth server
 */

import { Command } from "commander";
import {
  runServer,
  listServersCommand,
  showServerCommand,
  addServerCommand,
  removeServerCommand,
  editServerCommand,
  configInfoCommand,
  authLoginCommand,
  authLogoutCommand,
  authListCommand,
} from "./commands.js";
import * as fs from "fs";
import * as path from "path";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
);

const program = new Command();

program.name("codemode-bridge").description("Code Mode Bridge CLI").version(pkg.version);

// Main 'run' command
program
  .command("run")
  .description("Start the bridge MCP server (default command)")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file (default: ~/.config/codemode-bridge/mcp.json)"
  )
  .option(
    "-s, --servers <names>",
    "Comma-separated list of servers to connect to"
  )
  .option(
    "-d, --debug",
    "Enable debug logging"
  )
  .action(async (options) => {
    const servers = options.servers ? options.servers.split(",").map((s: string) => s.trim()) : undefined;
    await runServer(options.config, servers, options.debug);
  });

// Config command group
const config = program.command("config").description("Manage bridge configuration");

config
  .command("list")
  .description("List all configured servers")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((options) => {
    listServersCommand(options.config);
  });

config
  .command("show <name>")
  .description("Show a server configuration")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, options) => {
    showServerCommand(name, options.config);
  });

config
  .command("add <name> [commandAndArgs...]")
  .description("Add a new server configuration")
  .requiredOption(
    "-t, --type <type>",
    "Server type (stdio or http)"
  )
  .option(
    "--url <url>",
    "Server URL (required for http servers)"
  )
  .option(
    "--env <env...>",
    'Environment variables as KEY=VALUE pairs'
  )
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, commandAndArgs, options) => {
    let command: string | undefined;
    let args: string[] | undefined;

    // Parse command and args from positional arguments
    if (commandAndArgs && commandAndArgs.length > 0) {
      command = commandAndArgs[0];
      if (commandAndArgs.length > 1) {
        args = commandAndArgs.slice(1);
      }
    }

    const env: Record<string, string> = {};
    if (options.env) {
      for (const pair of options.env) {
        const [key, value] = pair.split("=");
        if (key && value) {
          env[key] = value;
        }
      }
    }

    addServerCommand(
      name,
      {
        type: options.type,
        command,
        args,
        url: options.url,
        env: Object.keys(env).length > 0 ? env : undefined,
      },
      options.config
    );
  });

config
  .command("remove <name>")
  .description("Remove a server configuration")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, options) => {
    removeServerCommand(name, options.config);
  });

config
  .command("edit <name> [commandAndArgs...]")
  .description("Edit a server configuration")
  .option(
    "-t, --type <type>",
    "Server type (stdio or http)"
  )
  .option(
    "--url <url>",
    "Server URL (for http servers)"
  )
  .option(
    "--env <env...>",
    'Environment variables as KEY=VALUE pairs'
  )
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, commandAndArgs, options) => {
    let command: string | undefined;
    let args: string[] | undefined;

    // Parse command and args from positional arguments
    if (commandAndArgs && commandAndArgs.length > 0) {
      command = commandAndArgs[0];
      if (commandAndArgs.length > 1) {
        args = commandAndArgs.slice(1);
      }
    }

    const env: Record<string, string> = {};
    if (options.env) {
      for (const pair of options.env) {
        const [key, value] = pair.split("=");
        if (key && value) {
          env[key] = value;
        }
      }
    }

    editServerCommand(
      name,
      {
        type: options.type,
        command,
        args,
        url: options.url,
        env: Object.keys(env).length > 0 ? env : undefined,
      },
      options.config
    );
  });

config
   .command("info")
   .description("Show configuration file information")
   .option(
     "-c, --config <path>",
     "Path to mcp.json configuration file"
   )
   .action((options) => {
     configInfoCommand(options.config);
   });

// Auth command group
const auth = program.command("auth").description("Manage OAuth authentication");

auth
  .command("list")
  .description("List all OAuth-enabled servers and their authentication status")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((options) => {
    authListCommand(options.config);
  });

auth
  .command("login <server-name>")
  .description("Initiate OAuth login for a server")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action(async (serverName, options) => {
    await authLoginCommand(serverName, options.config);
  });

auth
  .command("logout <server-name>")
  .description("Logout from an OAuth server (clears all authentication data)")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((serverName, options) => {
    authLogoutCommand(serverName, options.config);
  });

// Default command: run if no command specified
program.action(async () => {
  // If no command is specified, run the bridge
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await runServer(undefined, undefined, false);
  }
});

program.parse();
