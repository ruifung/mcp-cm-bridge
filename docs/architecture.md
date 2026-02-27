# Architecture

Code Mode Bridge acts as a protocol multiplexer and execution sandbox. It bridges multiple upstream MCP servers into a single interface.

## How It Works

1.  **Connection**: The bridge connects to all configured upstream MCP servers (via stdio or HTTP).
2.  **Tool Collection**: It gathers tool definitions from all servers via the MCP protocol.
3.  **Tool Wrapping**: It uses the Code Mode SDK to wrap these tools with auto-generated TypeScript definitions.
4.  **Exposure**: It exposes two MCP tools to the client: `eval` (for code execution) and `status` (for introspection).
5.  **Execution**: When `eval` is called, the bridge runs the provided code in a selected [executor](./executors.md) sandbox, providing access to upstream tools via the `codemode.*` namespace.

## Logical Flow

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
|  |  deno | isolated-vm | container | vm2            |   |
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
|   +-- deno-executor.ts      # Deno sandbox executor
|   +-- vm2-executor.ts       # VM2 sandbox executor
|   +-- isolated-vm-executor.ts  # isolated-vm V8 isolate executor
|   +-- container-executor.ts # Docker/Podman container executor (unified wrapper)
|   +-- container-socket-executor.ts # Dockerode socket implementation
|   +-- container-cli-executor.ts    # CLI fallback implementation
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
|   +-- env.ts                # Environment detection (Node/Bun/Deno)
|   +-- logger.ts             # Winston logger
|   +-- docker.ts             # Docker socket discovery
+-- index.ts                  # Package main entry point
```
