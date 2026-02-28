# Code Mode Bridge

[![npm](https://img.shields.io/npm/v/@ruifung/codemode-bridge)](https://www.npmjs.com/package/@ruifung/codemode-bridge)

An MCP (Model Context Protocol) multiplexer that connects to upstream MCP servers and exposes all their tools through a single `sandbox_eval_js` tool for unified orchestration and execution. Runs on **Node.js** and **Deno**. Bun is not officially supported — if you need to use Bun, ensure a container runtime (Docker or Podman) or Deno is available in your PATH so the bridge can delegate code execution to a supported executor.

## Key Features

- **Multi-server bridging**: Connect to multiple upstream MCP servers simultaneously.
- **Tool aggregation**: Exposes all upstream functions through a single `sandbox_eval_js` tool.
- **Dynamic discovery**: Three built-in discovery tools let agents find and inspect available functions before writing code.
- **Multi-executor sandbox**: Secure execution via Deno, isolated-vm, Docker/Podman containers, or vm2.
- **Automatic detection**: Automatically selects the best available executor for your environment.
- **Live reload**: Watches `mcp.json` for changes and hot-reloads upstream connections without restarting.
- **CLI management**: Easy command-line interface for server configuration.

## Quick Start

### Installation & Run

```bash
# Run without installing
npx @ruifung/codemode-bridge

# Or install globally
npm install -g @ruifung/codemode-bridge
codemode-bridge run
```

### Basic Usage

1.  **Add a server**:
    ```bash
    codemode-bridge config add kubernetes --type stdio --command "npx" --args "-y,kubernetes-mcp-server@latest"
    ```
2.  **Start the bridge**:
    ```bash
    codemode-bridge run
    ```
3.  **Use in your client**: Point your MCP client (Claude Desktop, VS Code, etc.) to `npx @ruifung/codemode-bridge`.

## Discovery Tools

The bridge exposes three tools for discovering what's available before writing `sandbox_eval_js` code:

| Tool | Description |
|------|-------------|
| `sandbox_get_functions` | List all available functions grouped by server. Accepts an optional `server` filter. |
| `sandbox_get_function_schema` | Get the TypeScript type definition for a specific function by name. |
| `sandbox_search_functions` | Keyword-search all function names and descriptions. Returns matching functions with their schemas. |

Use these before calling `sandbox_eval_js` to find the correct function name and parameter types.

## Using the `sandbox_eval_js` Tool

The `sandbox_eval_js` tool executes JavaScript in a sandboxed environment with access to all upstream functions via the `codemode` object. You can write either a function body or a complete async arrow function:

```javascript
// Function body (auto-wrapped):
const result = await codemode.server_name__function_name({ param: "value" });
return result;

// Or as a complete async arrow function:
async () => {
  const result = await codemode.server_name__function_name({ param: "value" });
  return result;
}
```

## Documentation Index

- [**Architecture**](./docs/architecture.md): How the bridge works, project structure, and logical flow.
- [**Executors**](./docs/executors.md): Detailed comparison of sandbox backends (Deno, isolated-vm, Containers).
- [**CLI & Configuration**](./docs/cli.md): Full command reference and configuration format.
- [**HTTP Serve Mode**](./docs/http-serve.md): Multi-client HTTP transport, session isolation, and security.
- [**Integration Guide**](./docs/integration.md): Setup instructions for Claude Desktop, VS Code, and more.
- [**Development**](./docs/development.md): Build and test instructions for contributors.
- [**Sandbox Hardening**](./docs/sandbox-hardening.md): Security details for the execution environments.
