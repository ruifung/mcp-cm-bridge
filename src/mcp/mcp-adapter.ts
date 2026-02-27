/**
 * MCP Adapter - Shim layer between AI SDK Tools and MCP Protocol
 * 
 * Converts AI SDK Tool format (from @cloudflare/codemode) to MCP protocol format
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "ai";
import { z } from "zod";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { Executor, ToolDescriptors } from "@cloudflare/codemode";

export type { RegisteredTool };

// Map type alias used by createSessionAwareToolHandler
export type ToolDescriptorMap = ToolDescriptors;

/**
 * A function that resolves the appropriate Executor for a given session.
 * Called per tool invocation to obtain the session's executor.
 *
 * @param sessionId - MCP session ID (undefined in stdio / stateless mode)
 * @returns The executor to use for this invocation
 */
export type ExecutorResolver = (sessionId?: string) => Promise<Executor>;

/**
 * Creates a reusable per-session tool handler that resolves the correct executor
 * for each invocation. Used both by adaptAISDKToolToMCP and rebuildEvalTool to
 * avoid duplicating the session-aware execution pattern.
 */
export function createSessionAwareToolHandler(
  executorResolver: ExecutorResolver,
  getDescriptors: () => ToolDescriptorMap,
): (args: any, extra: any) => Promise<CallToolResult> {
  return async (args: any, extra: any): Promise<CallToolResult> => {
    try {
      const sessionId = extra?.sessionId as string | undefined;
      const executor = await executorResolver(sessionId);
      const sessionTool = createCodeTool({ tools: getDescriptors(), executor });
      const result = await (sessionTool.execute as Function)(args);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] } as any;
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
      } as any;
    }
  };
}

/**
 * Adapts an AI SDK Tool to MCP protocol format.
 * Takes a codemode SDK tool and registers it with the MCP server.
 * Returns the RegisteredTool handle so the caller can call .update() later.
 *
 * When `executorResolver` and `getDescriptors` are provided the handler
 * creates a fresh codemode tool per invocation using the session-specific
 * executor — enabling multi-client isolation in HTTP mode.
 *
 * When neither is provided the original `tool.execute` closure is called
 * directly, which preserves the existing stdio / singleton-executor behaviour.
 */
export async function adaptAISDKToolToMCP(
  mcp: McpServer,
  tool: Tool<any, any>,
  executorResolver?: ExecutorResolver,
  getDescriptors?: () => ToolDescriptors
): Promise<RegisteredTool> {
  // The tool from createCodeTool has:
  // - tool.description
  // - tool.inputSchema (Zod schema)
  // - tool.execute (async function)

  // Extract tool name from description or use default
  const toolName = "eval";

  // Build the per-invocation handler. If resolver + descriptors are provided,
  // use the shared session-aware helper; otherwise call tool.execute directly.
  const handler: (args: any, extra: any) => Promise<any> =
    executorResolver && getDescriptors
      ? createSessionAwareToolHandler(executorResolver, getDescriptors)
      : async (args: any) => {
          try {
            const result = await (tool.execute as Function)(args);
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return { content: [{ type: "text" as const, text }] } as any;
          } catch (error) {
            return {
              content: [{
                type: "text" as const,
                text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
            } as any;
          }
        };

  // Register the tool with the MCP server
  const registeredTool = mcp.registerTool(
    toolName,
    {
      description: tool.description || "Execute code with tool orchestration",
      // Use the Zod schema directly - MCP's registerTool handles conversion
      // Cast to any to avoid schema compatibility issues between AI SDK and MCP
      inputSchema: (tool.inputSchema as any) || z.object({}).strict(),
    },
    // Handler for MCP tool calls — second parameter carries MCP request context
    // including the session ID when running in stateful HTTP mode.
    handler
  );

  return registeredTool;
}
