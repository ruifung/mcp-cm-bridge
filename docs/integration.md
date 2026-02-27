# IDE & Client Integration

You can add Code Mode Bridge to any MCP-compatible client. This allows your AI agent to orchestrate multiple tools through a single interface.

## VS Code / GitHub Copilot

Add to your `.vscode/mcp.json` (workspace) or user `settings.json`:

```json
{
  "servers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "@ruifung/codemode-bridge"]
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
      "args": ["-y", "@ruifung/codemode-bridge", "--servers", "kubernetes,time"]
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
      "args": ["-y", "@ruifung/codemode-bridge"],
      "env": {
        "EXECUTOR_TYPE": "container"
      }
    }
  }
}
```

## Claude Desktop

Add to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "codemode-bridge": {
      "command": "npx",
      "args": ["-y", "@ruifung/codemode-bridge"]
    }
  }
}
```

## OpenCode

Add to `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "mcp": {
    "codemode-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ruifung/codemode-bridge"]
    }
  }
}
```

## Global Installation Note

If you've installed the package globally (`npm install -g @ruifung/codemode-bridge`), you can replace the `npx` command with the direct binary to avoid the startup overhead of `npx`:

```json
{
  "command": "codemode-bridge",
  "args": []
}
```
