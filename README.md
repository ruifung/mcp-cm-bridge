# Code Mode Bridge

An MCP (Model Context Protocol) server that connects to upstream MCP servers and exposes all their tools through a single `eval` tool for unified orchestration and execution.

## Features

- **Multi-server bridging**: Connect to multiple upstream MCP servers simultaneously
- **Tool aggregation**: Exposes all upstream tools through a single `eval` tool
- **Dynamic discovery**: Auto-generated TypeScript type definitions show agents exactly what's available
- **Namespaced tools**: Tools are automatically namespaced by server (e.g., `kubernetes__pods_list`)
- **Multi-executor sandbox**: Three executor backends with automatic selection
  - **isolated-vm** (preferred) -- V8 isolate with strict JS-level sandboxing
  - **container** -- Docker/Podman with OS-level isolation (`--network=none`, `--read-only`, `--cap-drop=ALL`)
  - **vm2** -- Lightweight VM2 sandbox
- **Status introspection**: Built-in `status` tool reports executor type, upstream servers, and available tools
- **CLI management**: Command-line interface for server configuration

## Quick Start

### Installation

Install directly from GitHub:

```bash
# Run without installing
npx git+https://github.com/ruifung/mcp-cm-bridge.git run

# Or install globally
npm install -g git+https://github.com/ruifung/mcp-cm-bridge.git
codemode-bridge run
```

#### Windows Users

Global install from the git URL may fail on Windows due to the 260-character MAX_PATH limit (`TAR_ENTRY_ERROR ENOENT` during extraction). Install from the prebuilt release tarball instead:

```bash
npm install -g https://github.com/ruifung/mcp-cm-bridge/releases/download/v1.0.1/ruifung-codemode-bridge-1.0.1.tgz
```

Check the [latest release](https://github.com/ruifung/mcp-cm-bridge/releases/latest) for the most recent tarball URL. The `npx` method also works fine on Windows since it uses shorter temp paths.

#### GitHub Packages (npm registry)

This package is published to the GitHub npm registry (not the public npm registry). To install from there, first configure npm to use GitHub Packages for the `@ruifung` scope:

```bash
echo "@ruifung:registry=https://npm.pkg.github.com" >> ~/.npmrc
```

Then install:

```bash
npm install -g @ruifung/codemode-bridge
```

> **Note:** GitHub Packages requires authentication even for public packages. You'll need a GitHub personal access token with `read:packages` scope. Add it to your `~/.npmrc`:
> ```
> //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
> ```

#### From Source

```bash
git clone https://github.com/ruifung/mcp-cm-bridge.git
cd mcp-cm-bridge
npm install
npm run build
node dist/cli/index.js run

# Or run in dev mode (builds and runs in one step)
npm run dev
```

### Basic Usage

List configured servers:

```bash
codemode-bridge config list
```

Add a new server:

```bash
codemode-bridge config add kubernetes --type stdio --command "npx" --args "-y,kubernetes-mcp-server@latest"
```

Start the bridge (loads all configured servers):

```bash
codemode-bridge run
```

Load specific servers:

```bash
codemode-bridge run --servers kubernetes,time
```

## Configuration

Servers are stored in `~/.config/codemode-bridge/mcp.json`:

```json
{
  "servers": {
    "kubernetes": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "kubernetes-mcp-server@latest"]
    },
    "time": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-server-time"]
    },
    "example-http": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

### Server Types

- **stdio**: Execute a command that runs an MCP server via stdin/stdout
- **http**: Connect to an HTTP-based MCP server (supports OAuth)

## Executors

The bridge supports three executor backends. On startup, it automatically selects the best available one, or you can force a specific executor via the `EXECUTOR_TYPE` environment variable.

### Selection Order (auto-detect)

| Priority | Executor | Selection Criteria |
|----------|------------|---------------------------------------------|
| 0 | `isolated-vm` | `isolated-vm` npm package is installed |
| 1 | `container` | Docker or Podman runtime is available |
| 2 | `vm2` | Always available (bundled dependency) |

### Environment Variables

| Variable | Description |
|------|-------------|
| `EXECUTOR_TYPE` | Force a specific executor: `isolated-vm`, `container`, or `vm2`. Throws if unavailable. |
| `CONTAINER_RUNTIME` | Override container runtime detection (e.g., `podman`, `/usr/bin/docker`). |

### Executor Comparison

| Feature | isolated-vm | container | vm2 |
|---------|-------------|-----------|-----|
| JS-level sandboxing | Yes (V8 isolate) | No (full Node.js inside) | Yes (VM2 sandbox) |
| Network isolation | No APIs exposed | OS-level (`--network=none`) | No APIs exposed |
| File system isolation | No APIs exposed | OS-level (`--read-only`) | No APIs exposed |
| `require`/`process` blocked | Yes | No (container boundary) | Yes |
| Concurrency | Parallel | Serialized (one-at-a-time) | Parallel |
| Startup overhead | Low | Higher (container + worker thread) | Low |
| Security model | V8 process isolation | Container boundary | JS context isolation |

### Container Executor Security Flags

When using the container executor, each container runs with:

```
--network=none --read-only --cap-drop=ALL --user=node
--tmpfs /tmp:rw,noexec,nosuid,size=64m
--pids-limit=64 --memory=256m --cpus=1.0
```

## How It Works

1. **Connection**: Connects to all configured upstream MCP servers
2. **Tool Collection**: Gathers tools from all servers via the MCP protocol
3. **Tool Wrapping**: Uses `@cloudflare/codemode` SDK to wrap all tools with auto-generated TypeScript definitions
4. **Exposure**: Exposes two MCP tools -- `eval` (code execution) and `status` (introspection)
5. **Execution**: Runs agent-generated code in the selected executor sandbox with tool access via `codemode.*`

## MCP Tools

### `eval`

Executes agent-generated JavaScript/TypeScript code with access to all upstream tools via the `codemode` namespace.

```typescript
// Example: cross-server orchestration
const time = await codemode.time__get_current_time({ timezone: "America/New_York" });
const pods = await codemode.kubernetes__pods_list_in_namespace({ namespace: "default" });
return { time, podCount: pods.length };
```

### `status`

Returns metadata about the running bridge: executor type, selection reason, timeout, and a list of all connected upstream servers with their tool counts.

## CLI Commands

```bash
# Start the bridge (default command)
codemode-bridge run [options]
  --servers <names>  Comma-separated list of servers to load
  --config <path>    Custom config file path

# Configuration management
codemode-bridge config list              # Show all configured servers
codemode-bridge config show <name>       # Show specific server config
codemode-bridge config add <name>        # Add new server
codemode-bridge config remove <name>     # Remove server
codemode-bridge config edit <name>       # Edit server config
codemode-bridge config info              # Show config file location
```

## Architecture

```
+---------------------------------------------------------+
|           MCP Clients (Claude, OpenCode, etc)           |
+------------------------+--------------------------------+
                         | MCP Protocol
                         |
+------------------------v--------------------------------+
|         Code Mode Bridge (MCP Server)                   |
|  +--------------------------------------------------+   |
|  |  "eval" Tool            "status" Tool             |   |
|  |  - Auto-generated type definitions                |   |
|  |  - Sandbox code execution                         |   |
|  |  - Tool orchestration                             |   |
|  +--------------------------------------------------+   |
|  +--------------------------------------------------+   |
|  |  Executor Registry                                |   |
|  |  isolated-vm | container | vm2                    |   |
|  +--------------------------------------------------+   |
+------------------------+--------------------------------+
                         | MCP Client (@ai-sdk/mcp)
            +------------+------------+-----------+
            |            |            |           |
       +----v-----+ +---v----+ +----v------+ +--v-------+
       |Kubernetes | |  Time  | | GitLab    | | Memory   |
       |  Server   | | Server | |  Server   | |  Server  |
       +----------+ +--------+ +-----------+ +----------+
```

## Project Structure

```
src/
+-- cli/
|   +-- index.ts              # CLI entry point
|   +-- commands.ts           # Command implementations
|   +-- config-manager.ts     # Configuration file management
+-- executor/
|   +-- vm2-executor.ts       # VM2 sandbox executor
|   +-- isolated-vm-executor.ts  # isolated-vm V8 isolate executor
|   +-- container-executor.ts # Docker/Podman container executor
|   +-- container-runner.mjs  # Container main thread (stdin/stdout RPC)
|   +-- container-worker.mjs  # Container worker thread (eval + console capture)
|   +-- wrap-code.ts          # Shared code wrapping (acorn AST)
|   +-- executor-test-suite.ts   # Universal executor test suite
|   +-- executor-runner.test.ts  # Runs test suite against all executors
+-- mcp/
|   +-- server.ts             # MCP server + upstream connections
|   +-- executor.ts           # Executor factory, registry, and type exports
|   +-- mcp-adapter.ts        # Protocol adapter (AI SDK Tool -> MCP)
|   +-- mcp-client.ts         # Upstream MCP client management
|   +-- config.ts             # Configuration types
|   +-- oauth-handler.ts      # OAuth flow for HTTP MCP servers
|   +-- token-persistence.ts  # OAuth token storage
|   +-- e2e-bridge-test-suite.ts   # E2E bridge test suite
|   +-- e2e-bridge-runner.test.ts  # Runs E2E suite against all executors
+-- utils/
|   +-- logger.ts             # Winston logger
+-- index.ts                  # Package main entry point
```

## Development

### Build

```bash
npm run build
```

### Test

```bash
# Run all tests (executor unit + E2E bridge, all 3 executors)
npm test

# Run E2E bridge tests only
npm run test:e2e

# Run tests with UI
npx vitest --ui
```

### Test CLI locally

```bash
npm run dev -- run --servers time
npm run dev -- config list
```

## Security

- **Multi-layer isolation**: Three executor backends with different security tradeoffs
- **Timeout enforcement**: Configurable timeout (default 30s) prevents infinite loops
- **No network access**: All executors block network access (JS-level or OS-level)
- **No file system access**: Executors cannot read/write host files
- **Tool isolation**: Only tools from configured upstream servers are accessible
- **Container hardening**: Container executor runs non-root with dropped capabilities, read-only filesystem, PID/memory/CPU limits

## Prebuilt Servers

The bridge comes pre-configured with popular MCP servers:

- **kubernetes** -- Kubernetes cluster operations
- **swf_gitlab** -- GitLab integration
- **time** -- Time operations and timezone conversion
- **memory** -- Knowledge graph memory system
- **code-sandbox** -- Sandboxed code execution via Docker containers
- **mcp-git** -- Git operations
- **sequential-thinking** -- Structured reasoning
- **atlassian_cloud** -- Atlassian Cloud (Jira/Confluence) integration (HTTP + OAuth)
- **microsoft/markitdown** -- Document to markdown conversion

Run `codemode-bridge config list` to see all available servers.

## Adding to Your MCP Client

### VS Code / GitHub Copilot

Add to your `.vscode/mcp.json` (workspace) or user `settings.json`:

```json
{
  "servers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/ruifung/mcp-cm-bridge.git"]
    }
  }
}
```

To load only specific upstream servers:

```json
{
  "servers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/ruifung/mcp-cm-bridge.git", "--servers", "kubernetes,time"]
    }
  }
}
```

To force a specific executor:

```json
{
  "servers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/ruifung/mcp-cm-bridge.git"],
      "env": {
        "EXECUTOR_TYPE": "container"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/ruifung/mcp-cm-bridge.git"]
    }
  }
}
```

### OpenCode

Add to `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "mcp": {
    "codemode-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "git+https://github.com/ruifung/mcp-cm-bridge.git"]
    }
  }
}
```

### If installed globally

If you've installed the package globally (`npm install -g git+https://github.com/ruifung/mcp-cm-bridge.git`), replace the `npx` command with the direct binary:

```json
{
  "command": "codemode-bridge",
  "args": []
}
```

## AI Generated Code Disclosure

This project is largely AI-generated. It serves as an experiment to get Cloudflare's Code Mode SDK working locally without paying for Workers, by bridging upstream MCP servers through a sandboxed executor.
