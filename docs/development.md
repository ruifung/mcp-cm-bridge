# Development

Instructions for building, testing, and contributing to Code Mode Bridge.

## Getting Started

```bash
git clone https://github.com/ruifung/mcp-cm-bridge.git
cd mcp-cm-bridge
npm install
```

## Build

```bash
# Build the project
npm run build

# Run in dev mode (builds and runs in one step)
npm run dev -- run
```

## Testing

The project uses `vitest` for testing. The test suite covers both individual executors and E2E bridge functionality.

```bash
# Run all tests (executor unit + E2E bridge, all available executors)
npm test

# Run E2E bridge tests only
npm run test:e2e

# Run tests with UI
npx vitest --ui
```

### Local CLI Testing

You can test the CLI without installing it globally:

```bash
npm run dev -- run --servers time
npm run dev -- config list
```

## Security Disclosure

This project is largely AI-generated. It serves as an experiment to get Cloudflare's Code Mode SDK working locally by bridging upstream MCP servers through a sandboxed executor.

## Acknowledgements

This project is built on [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode), Cloudflare's Code Mode SDK. The SDK provides the core tool-wrapping and type-generation engine that enables agents to call multiple MCP tools through a single `eval` interface. This project adapts that capability to run locally using sandboxed executors.
