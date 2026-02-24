/**
 * MCP Server - Exposes the Code Mode bridge as an MCP server
 * 
 * Architecture:
 * - Upstream: Use AI SDK's createMCPClient() to connect to and collect tools from other MCP servers
 * - Orchestration: Pass collected tools to codemode SDK's createCodeTool()
 * - Downstream: Use MCP SDK to expose the codemode tool via MCP protocol (stdio transport)
 * 
 * This server:
 * 1. Connects to upstream MCP servers using AI SDK's createMCPClient()
 * 2. Collects tools from all upstream servers
 * 3. Uses @cloudflare/codemode SDK to create the "codemode" tool with those tools
 * 4. Adapts the codemode SDK's AI SDK Tool to MCP protocol using a shim layer
 * 5. Exposes the "codemode" tool via MCP protocol downstream
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { z } from "zod";
import { createExecutor } from "./executor.js";
import { adaptAISDKToolToMCP } from "./mcp-adapter.js";

/**
 * Configuration for an MCP server to connect to upstream
 */
export interface MCPServerConfig {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/**
 * Convert JSON Schema to Zod schema
 * MCP tools use JSON Schema, but createCodeTool expects Zod schemas
 */
function jsonSchemaToZod(schema: any): z.ZodType<any> {
  // Handle null/undefined
  if (!schema) {
    return z.object({}).strict();
  }

  // Handle object type
  if (schema.type === "object" || !schema.type) {
    const props: Record<string, z.ZodType<any>> = {};
    
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        props[key] = jsonSchemaToZod(prop as any);
      }
    }

    if (schema.required && Array.isArray(schema.required)) {
      const required = new Set(schema.required);
      const finalProps: Record<string, z.ZodType<any>> = {};
      
      for (const [key, zodSchema] of Object.entries(props)) {
        if (required.has(key)) {
          finalProps[key] = zodSchema;
        } else {
          finalProps[key] = (zodSchema as any).optional();
        }
      }
      return z.object(finalProps).strict();
    }
    
    // Make all fields optional if no required list
    const optionalProps: Record<string, z.ZodType<any>> = {};
    for (const [key, zodSchema] of Object.entries(props)) {
      optionalProps[key] = (zodSchema as any).optional();
    }
    return z.object(optionalProps).strict();
  }

  // Handle array type
  if (schema.type === "array") {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    return z.array(itemSchema);
  }

  // Handle string type
  if (schema.type === "string") {
    return z.string();
  }

  // Handle number type
  if (schema.type === "number") {
    return z.number();
  }

  // Handle integer type
  if (schema.type === "integer") {
    return z.number().int();
  }

  // Handle boolean type
  if (schema.type === "boolean") {
    return z.boolean();
  }

  // Default to any
  return z.any();
}

/**
 * Convert MCP raw tool definitions to ToolDescriptor format
 * that createCodeTool() expects
 */
function convertMCPToolToDescriptor(toolDef: any): any {
  return {
    description: toolDef.description || "",
    inputSchema: jsonSchemaToZod(toolDef.inputSchema),
    execute: toolDef.execute, // Pass through the execute function from AI SDK tool
  };
}

export async function startCodeModeBridgeServer(
  serverConfigs: MCPServerConfig[]
) {
  const mcp = new McpServer({
    name: "codemode-bridge",
    version: "1.0.0",
  });

  // Collect all tools from upstream MCP servers using AI SDK's MCP client
  const allAISDKTools: Record<string, any> = {};
  let totalToolCount = 0;

  for (const config of serverConfigs) {
    try {
      // Create client for this upstream MCP server using AI SDK
      let transport;
      
        if (config.type === "stdio") {
          if (!config.command) {
            console.error(
              `[Bridge] Skipping "${config.name}": stdio type requires "command" field`
            );
            continue;
          }
          
          // Merge provided env vars with current process env, filtering out undefined values
          const baseEnv = Object.fromEntries(
            Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<[string, string]>
          );
          const env = config.env ? { ...baseEnv, ...config.env } : baseEnv;
          
          transport = new Experimental_StdioMCPTransport({
            command: config.command,
            args: config.args || [],
            env,
          });
        } else {
        console.error(
          `[Bridge] Skipping "${config.name}": unsupported transport type "${config.type}"`
        );
        continue;
      }

      // Create AI SDK MCP client for this server
      const client = await createMCPClient({
        name: `codemode-bridge-client-${config.name}`,
        transport,
      });

      // Get tools from this server
      const serverTools = await client.tools();
      const toolCount = Object.keys(serverTools).length;
      totalToolCount += toolCount;

      console.error(
        `[Bridge] Server "${config.name}" has ${toolCount} tools`
      );

       // Namespace tools by server name to avoid conflicts
       // e.g., kubernetes.get_pod -> kubernetes__get_pod
       // The tools from client.tools() are already AI SDK Tools with execute functions
       // Convert them to ToolDescriptor format for createCodeTool
       for (const [toolName, tool] of Object.entries(serverTools)) {
         const namespacedName = `${config.name}__${toolName}`;
         // Convert the AI SDK tool to a ToolDescriptor format
         const descriptor = convertMCPToolToDescriptor(tool);
         allAISDKTools[namespacedName] = descriptor;
       }
    } catch (error) {
      console.error(
        `[Bridge] Failed to connect to "${config.name}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // Continue with other servers instead of failing completely
    }
  }

  console.error(
    `[Bridge] Total: ${totalToolCount} tools from ${serverConfigs.length} server(s)`
  );

  // Create the executor using the codemode SDK pattern
  const executor = createExecutor(30000); // 30 second timeout

  // Create the codemode tool using the codemode SDK
  // tools from client.tools() are already in AI SDK format
  console.error("[Bridge] Creating codemode tool with tools:", Object.keys(allAISDKTools));
  const codemodeTool = createCodeTool({
    tools: allAISDKTools,
    executor,
    // Let the SDK auto-generate description from available tools
  });

  // Adapt the AI SDK Tool to MCP protocol format and register it
  // The adaptAISDKToolToMCP function handles the protocol conversion
  await adaptAISDKToolToMCP(mcp, codemodeTool);

  // Connect downstream MCP transport (what the client connects to)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  console.error(`[Code Mode Bridge] Ready on stdio transport`);
  console.error(
    `[Code Mode Bridge] Connected to: ${serverConfigs.map((s) => s.name).join(", ")}`
  );
  console.error(`[Code Mode Bridge] Exposing single 'codemode' tool`);
}
