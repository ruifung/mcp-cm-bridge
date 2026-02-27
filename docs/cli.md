# CLI & Configuration

The Code Mode Bridge provides a command-line interface for managing upstream servers and running the bridge.

## CLI Commands

```bash
# Start the bridge (default command)
codemode-bridge run [options]
  --servers <names>    Comma-separated list of servers to load
  --config <path>      Custom config file path
  --executor <type>    Force executor (deno, isolated-vm, container, vm2)
  --debug              Enable debug logging

# Version information (lists available executors)
codemode-bridge --version

# Configuration management
codemode-bridge config list              # Show all configured servers
codemode-bridge config show <name>       # Show specific server config
codemode-bridge config add <name>        # Add new server
codemode-bridge config remove <name>     # Remove server
codemode-bridge config edit <name>       # Edit server config
codemode-bridge config info              # Show config file location
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
