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

// Bun is not supported — exit early with a helpful message
if (typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined') {
  console.error(
    'Error: codemode-bridge does not support Bun. Please use Node.js or Deno.',
  );
  process.exit(1);
}

import { Command } from "commander";
import {
  runServer,
  runServe,
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
import { getConfigFilePath } from "./config-manager.js";
import { getExecutorStatus } from "../mcp/executor-status.js";
import * as fs from "node:fs";
import * as path from "node:path";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
);

const defaultConfigPath = getConfigFilePath();

const program = new Command();

// Add logic to get available executors for version output
let versionString = pkg.version;
if (process.argv.includes("-V") || process.argv.includes("--version")) {
  const statuses = await getExecutorStatus();
  const available = statuses
    .filter((s) => s.isAvailable)
    .map((s) => s.type)
    .join(", ");
  if (available) {
    versionString = `${pkg.version} (executors: ${available})`;
  }
}

program
  .name("codemode-bridge")
  .description("Code Mode Bridge CLI - Connects to multiple MCP servers and exposes them as a single tool")
  .version(versionString);

// Main 'run' command
program
  .command("run", { isDefault: true })
  .description("Start the bridge MCP server (default command)")
  .option(
    "-c, --config <path>",
    `Path to mcp.json configuration file (default: ${defaultConfigPath})`
  )
  .option(
    "-s, --servers <names>",
    "Comma-separated list of servers to connect to"
  )
  .option(
    "-d, --debug",
    "Enable debug logging"
  )
  .option(
    "-e, --executor <type>",
    "Executor type (isolated-vm, vm2, container, deno)"
  )
  .action(async (options) => {
    const servers = options.servers ? options.servers.split(",").map((s: string) => s.trim()) : undefined;
    await runServer(options.config, servers, options.debug, options.executor);
  });

// 'serve' command — HTTP transport
program
  .command("serve")
  .description("Start the bridge MCP server over HTTP (StreamableHTTP transport)")
  .option(
    "-c, --config <path>",
    `Path to mcp.json configuration file (default: ${defaultConfigPath})`
  )
  .option(
    "-s, --servers <names>",
    "Comma-separated list of servers to connect to"
  )
  .option(
    "-d, --debug",
    "Enable debug logging"
  )
  .option(
    "-e, --executor <type>",
    "Executor type (isolated-vm, vm2, container, deno)"
  )
  .option(
    "-p, --port <number>",
    "Port to listen on",
    "3000"
  )
  .option(
    "--host <string>",
    "Host to bind to",
    "localhost"
  )
  .action(async (options) => {
    const servers = options.servers ? options.servers.split(",").map((s: string) => s.trim()) : undefined;
    const port = parseInt(options.port, 10);
    await runServe(options.config, servers, options.debug, options.executor, port, options.host);
  });

// Config command group
const config = program.command("config").description("Manage bridge configuration").enablePositionalOptions();

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
  .command("show <server-name>")
  .description("Show a server configuration")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, options) => {
    showServerCommand(name, options.config);
  });

config
  .command("add <server-name> [commandAndArgs...]")
  .description("Add a new server configuration (use -- before commands with flags, e.g. -- npx -y @some/pkg)")
  .passThroughOptions()
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
  .addHelpText("after", `
Examples:
  $ codemode-bridge config add my-server --type stdio node /path/to/server.js
  $ codemode-bridge config add remote-server --type http --url https://api.example.com/mcp
  $ codemode-bridge config add secure-server --type stdio --env API_KEY=secret python server.py
  $ codemode-bridge config add npx-server --type stdio -- npx -y @modelcontextprotocol/server-everything
`)
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
  .command("remove <server-name>")
  .description("Remove a server configuration")
  .option(
    "-c, --config <path>",
    "Path to mcp.json configuration file"
  )
  .action((name, options) => {
    removeServerCommand(name, options.config);
  });

config
  .command("edit <server-name> [commandAndArgs...]")
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
  .addHelpText("after", `
Examples:
  $ codemode-bridge config edit my-server node /new/path/to/server.js
  $ codemode-bridge config edit remote-server --url https://new-api.example.com/mcp
  $ codemode-bridge config edit secure-server --env API_KEY=new-secret
`)
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

program.parse();

