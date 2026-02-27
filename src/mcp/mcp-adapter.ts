/**
 * MCP Adapter - Shim layer between AI SDK Tools and MCP Protocol
 * 
 * Converts AI SDK Tool format (from @cloudflare/codemode) to MCP protocol format
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "ai";
import { z } from "zod";

export type { RegisteredTool };

/**
 * Adapts an AI SDK Tool to MCP protocol format
 * Takes a codemode SDK tool and registers it with the MCP server
 * Returns the RegisteredTool handle so the caller can call .update() later.
 */
export async function adaptAISDKToolToMCP(
  mcp: McpServer,
  tool: Tool<any, any>
): Promise<RegisteredTool> {
  // The tool from createCodeTool has:
  // - tool.description
  // - tool.inputSchema (Zod schema)
  // - tool.execute (async function)

  // Extract tool name from description or use default
  const toolName = "eval";

  // Register the tool with the MCP server
  const registeredTool = mcp.registerTool(
    toolName,
    {
      description: tool.description || "Execute code with tool orchestration",
      // Use the Zod schema directly - MCP's registerTool handles conversion
      // Cast to any to avoid schema compatibility issues between AI SDK and MCP
      inputSchema: (tool.inputSchema as any) || z.object({}).strict(),
    },
    // Handler for MCP tool calls
    async (args: any) => {
      try {
        // Call the AI SDK tool's execute method
        // The execute function expects the input args
        const result = await (tool.execute as Function)(args);

        // If result is a string (from fallback tool), use as-is
        // Otherwise format to JSON
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text" as const, text }],
        } as any;
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        } as any;
      }
    }
  );

  return registeredTool;
}
