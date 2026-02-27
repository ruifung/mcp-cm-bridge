# CLI & Configuration

The Code Mode Bridge provides a command-line interface for managing upstream servers and running the bridge.

## CLI Commands

### `run`

Starts the bridge using the MCP stdio transport. This is the default transport and is used by AI assistants that communicate over stdin/stdout (e.g. Claude Desktop, OpenCode).

```bash
codemode-bridge run [options]
  -c, --config <path>      Path to mcp.json config file
  -s, --servers <names>    Comma-separated list of servers to load
  -d, --debug              Enable debug logging
  -e, --executor <type>    Force executor type (deno, isolated-vm, container, vm2)
```

```bash
# Start with all configured servers
codemode-bridge run

# Start with a specific config and executor
codemode-bridge run --config ./my-config.json --executor deno

# Load only specific servers
codemode-bridge run --servers "kubernetes,time"
```

### `serve`

Starts the bridge as an HTTP server using the MCP StreamableHTTP transport. Supports multiple concurrent clients, each with isolated execution contexts.

For detailed HTTP serve mode documentation including architecture and security considerations, see [HTTP Serve Mode](./http-serve.md).

```bash
codemode-bridge serve [options]
  -c, --config <path>      Path to mcp.json config file
  -s, --servers <names>    Comma-separated list of servers to load
  -d, --debug              Enable debug logging
  -e, --executor <type>    Force executor type (deno, isolated-vm, container, vm2)
  -p, --port <number>      Port to listen on (default: 3000)
      --host <string>      Host to bind to (default: localhost)
```

```bash
# Start HTTP server on default port 3000
codemode-bridge serve

# Custom port and host
codemode-bridge serve --port 8080 --host 0.0.0.0

# With specific config and executor
codemode-bridge serve --config ./my-config.json --executor vm2

# Only load specific servers
codemode-bridge serve --servers "github,slack" --port 3000
```

**Endpoints:**

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | `POST` | MCP protocol messages (initialize, tool calls, etc.) |
| `/mcp` | `GET` | SSE stream for server-to-client notifications |
| `/mcp` | `DELETE` | Close a session |
| `/health` | `GET` | Health check — returns `{"status": "ok"}` |

> **`run` vs `serve`:** `run` uses stdio transport (one client, suitable for desktop AI assistants). `serve` uses HTTP transport and handles multiple concurrent clients with isolated sessions.

### `config`

Manages the server configuration file.

```bash
codemode-bridge config list              # Show all configured servers
codemode-bridge config show <name>       # Show specific server config
codemode-bridge config add <name>        # Add new server
codemode-bridge config remove <name>     # Remove server
codemode-bridge config edit <name>       # Edit server config
codemode-bridge config info              # Show config file location
```

### `--version`

Lists available executors and prints version information.

```bash
codemode-bridge --version
```

## Configuration Format

Servers are stored in `~/.config/codemode-bridge/mcp.json` (on Windows, typically `C:\Users\<user>\.config\codemode-bridge\mcp.json`).

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

- **stdio**: Execute a command that runs an MCP server via stdin/stdout. This is the most common type for local servers.
- **http**: Connect to an HTTP-based MCP server. Supports OAuth flows for authenticated services.

## MCP Tools Reference

The bridge exposes two primary tools to the client:

### `eval`

Executes agent-generated JavaScript/TypeScript code with access to all upstream tools via the `codemode` namespace.

```typescript
// Example: cross-server orchestration
const time = await codemode.time__get_current_time({ timezone: "America/New_York" });
const pods = await codemode.kubernetes__pods_list_in_namespace({ namespace: "default" });
return { time, podCount: pods.length };
```

### `status`

Returns metadata about the running bridge:
- Current executor type and selection reason
- Configuration timeout
- List of connected upstream servers
- Tool count per server
