# Code Mode Bridge

[![npm](https://img.shields.io/npm/v/@ruifung/codemode-bridge)](https://www.npmjs.com/package/@ruifung/codemode-bridge)

An MCP (Model Context Protocol) server that connects to upstream MCP servers and exposes all their tools through a single `eval` tool for unified orchestration and execution. Supports Node.js, Bun, and Deno runtimes.

## Key Features

- **Multi-server bridging**: Connect to multiple upstream MCP servers simultaneously.
- **Tool aggregation**: Exposes all upstream tools through a single `eval` tool.
- **Dynamic discovery**: Auto-generated TypeScript type definitions show agents exactly what's available.
- **Multi-executor sandbox**: Secure execution via Deno, isolated-vm, Docker/Podman containers, or vm2.
- **Automatic detection**: Automatically selects the best available executor for your environment.
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

## Documentation Index

- [**Architecture**](./docs/architecture.md): How the bridge works, project structure, and logical flow.
- [**Executors**](./docs/executors.md): Detailed comparison of sandbox backends (Deno, isolated-vm, Containers).
- [**CLI & Configuration**](./docs/cli.md): Full command reference and configuration format.
- [**HTTP Serve Mode**](./docs/http-serve.md): Multi-client HTTP transport, session isolation, and security.
- [**Integration Guide**](./docs/integration.md): Setup instructions for Claude Desktop, VS Code, and more.
- [**Development**](./docs/development.md): Build and test instructions for contributors.
- [**Sandbox Hardening**](./docs/sandbox-hardening.md): Security details for the execution environments.

## Acknowledgements

Built on Cloudflare's [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) SDK.
