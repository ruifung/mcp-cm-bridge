# Code Mode Bridge

An MCP (Model Context Protocol) server that connects to upstream MCP servers and exposes all their tools through a single `codemode` tool for unified orchestration and execution.

## Features

- **Multi-server bridging**: Connect to multiple upstream MCP servers simultaneously
- **Tool aggregation**: Exposes all upstream tools through a single `codemode` tool
- **Dynamic discovery**: Auto-generated tool descriptions show agents exactly what's available
- **Namespaced tools**: Tools are automatically namespaced by server (e.g., `kubernetes__pods_list`)
- **Sandbox execution**: Code runs in isolated vm2 sandbox with 30-second timeout
- **CLI management**: Easy command-line interface for server configuration
- **npx compatible**: Run directly with `npx codemode-bridge`

## Quick Start

### Installation

```bash
npm install -g codemode-bridge
# or use directly with npx
npx codemode-bridge --help
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
- **http**: Connect to an HTTP-based MCP server

## How It Works

1. **Connection**: Connects to all configured upstream MCP servers using Vercel AI SDK's MCP client
2. **Tool Collection**: Gathers tools from all servers via the MCP protocol
3. **Tool Wrapping**: Uses @cloudflare/codemode SDK to wrap all tools
4. **Code Generation**: SDK auto-generates TypeScript type definitions for tools
5. **Exposure**: Exposes a single `codemode` MCP tool that agents can call
6. **Execution**: Runs agent-generated code in isolated vm2 sandbox with tool access

## Tool Discovery

When agents query the `codemode` tool schema, the auto-generated description includes:

- TypeScript type definitions for all available tools
- Complete function signatures
- Tool descriptions and parameter documentation
- Example usage patterns

This allows agents to discover the complete API surface by reading the tool description.

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

## Examples

### Using with mcporter

```bash
# Start the bridge
codemode-bridge run --servers kubernetes &

# List available tools
mcporter list codemode-bridge --schema

# Call the codemode tool
mcporter call codemode-bridge.codemode code='async () => {
  const namespaces = await codemode.kubernetes__namespaces_list({});
  return namespaces;
}'
```

### Using with Claude or other LLMs

When connected as an MCP server, Claude can:

1. See the `codemode` tool in its tool list
2. Read auto-generated documentation about all available tools
3. Write code that orchestrates multiple tools across servers
4. Execute the code in an isolated sandbox

Example code an LLM might write:

```typescript
// Get current time and convert to different timezone
const now = await codemode.time__get_current_time({ timezone: "America/New_York" });
const singapore = await codemode.time__convert_time({
  source_timezone: "America/New_York",
  target_timezone: "Asia/Singapore",
  time: now
});
return { newYork: now, singapore };
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│           MCP Clients (Claude, mcporter, etc)           │
└────────────────────┬────────────────────────────────────┘
                     │ MCP Protocol
                     │
┌────────────────────▼────────────────────────────────────┐
│         Code Mode Bridge (MCP Server)                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Single "codemode" Tool                          │   │
│  │  - Auto-generated type definitions               │   │
│  │  - Sandbox code execution                        │   │
│  │  - Tool orchestration                            │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────┘
                     │ @ai-sdk/mcp (MCP Client)
        ┌────────────┼────────────┬─────────────┐
        │            │            │             │
   ┌────▼─────┐ ┌───▼────┐ ┌────▼──────┐ ┌───▼──────┐
   │Kubernetes │ │  Time  │ │ GitLab    │ │ Memory   │
   │  Server   │ │ Server │ │  Server   │ │  Server  │
   └──────────┘ └────────┘ └───────────┘ └──────────┘
```

## Project Structure

```
src/
├── cli/
│   ├── index.ts              # CLI entry point (with #!/usr/bin/env node shebang)
│   ├── commands.ts           # Command implementations
│   └── config-manager.ts     # Configuration management
├── mcp/
│   ├── server.ts             # MCP server + upstream connections
│   ├── executor.ts           # VM2 sandbox executor implementation
│   ├── mcp-adapter.ts        # Protocol adapter (AI SDK Tool → MCP)
│   └── config.ts             # Configuration types
└── index.ts                  # Package main entry point

config/
└── mcporter.json             # mcporter client configuration

dist/                          # Compiled JavaScript (generated)
.gitignore                     # Git ignore patterns
package.json                   # NPM package configuration
tsconfig.json                  # TypeScript configuration
README.md                      # This file
```

## Development

### Build

```bash
npm run build
```

### Test CLI locally

```bash
npm run dev:cli -- run --servers time
npm run dev:cli -- config list
npm run dev:cli -- config show kubernetes
```

### Rebuild and test after changes

```bash
npm run build
npx codemode-bridge config list
```

## Security

- **Sandboxed execution**: Code runs in isolated vm2 environment
- **Timeout enforcement**: 30-second limit prevents infinite loops
- **No network access**: Sandbox cannot make direct HTTP requests
- **No file system access**: Cannot read/write files on host
- **Tool isolation**: Only tools from configured servers are accessible

## Prebuilt Servers

The bridge comes pre-configured with popular MCP servers:

- **kubernetes** - Kubernetes cluster operations
- **swf_gitlab** - GitLab integration (with SWF instance)
- **time** - Time operations and timezone conversion
- **memory** - Knowledge graph memory system
- **code-sandbox** - Sandboxed code execution
- **mcp-git** - Git operations
- **sequential-thinking** - Structured reasoning
- **atlassian_cloud** - Atlassian cloud integration (HTTP)

Run `codemode-bridge config list` to see all available servers.

## License

ISC
