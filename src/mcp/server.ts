/**
 * MCP Server - Exposes the Code Mode bridge as an MCP server
 * 
 * Architecture:
 * - Upstream: Use official MCP SDK's Client to connect to and collect tools from other MCP servers
 * - Orchestration: Pass collected tools to codemode SDK's createCodeTool()
 * - Downstream: Use MCP SDK to expose the codemode tool via MCP protocol (stdio transport)
 * 
 * This server:
 * 1. Connects to upstream MCP servers using official MCP SDK Client
 * 2. Collects tools from all upstream servers in native MCP format (JSON Schema)
 * 3. Converts tools to ToolDescriptor format (with Zod schemas)
 * 4. Uses @cloudflare/codemode SDK to create the "codemode" tool with those tools
 * 5. Adapts the codemode SDK's AI SDK Tool to MCP protocol using a shim layer
 * 6. Exposes the "codemode" tool via MCP protocol downstream
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { z } from "zod";
import { createExecutor } from "./executor.js";
import { adaptAISDKToolToMCP } from "./mcp-adapter.js";
import { MCPClient, type MCPServerConfig, type MCPTool } from "./mcp-client.js";
import { logDebug, logError, logInfo } from "../utils/logger.js";

// Re-export MCPServerConfig for backwards compatibility
export type { MCPServerConfig }

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
    let arraySchema = z.array(itemSchema);
    
    // Apply array constraints
    if (typeof schema.minItems === "number") {
      arraySchema = arraySchema.min(schema.minItems);
    }
    if (typeof schema.maxItems === "number") {
      arraySchema = arraySchema.max(schema.maxItems);
    }
    
    return arraySchema;
  }

  // Handle string type
  if (schema.type === "string") {
    let stringSchema = z.string();
    
    // Handle enum
    if (schema.enum && Array.isArray(schema.enum)) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    
    // Apply string format constraints
    if (schema.format) {
      switch (schema.format) {
        case "email":
          stringSchema = stringSchema.email();
          break;
        case "uuid":
          stringSchema = stringSchema.uuid();
          break;
        case "url":
          stringSchema = stringSchema.url();
          break;
        case "date-time":
          stringSchema = stringSchema.datetime();
          break;
      }
    }
    
    // Apply string length constraints
    if (typeof schema.minLength === "number") {
      stringSchema = stringSchema.min(schema.minLength);
    }
    if (typeof schema.maxLength === "number") {
      stringSchema = stringSchema.max(schema.maxLength);
    }
    if (schema.pattern) {
      stringSchema = stringSchema.regex(new RegExp(schema.pattern));
    }
    
    return stringSchema;
  }

  // Handle number type
  if (schema.type === "number") {
    let numberSchema = z.number();
    
    // Apply number constraints
    if (typeof schema.minimum === "number") {
      numberSchema = numberSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      numberSchema = numberSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      numberSchema = numberSchema.multipleOf(schema.multipleOf);
    }
    
    return numberSchema;
  }

  // Handle integer type
  if (schema.type === "integer") {
    let intSchema = z.number().int();
    
    // Apply number constraints
    if (typeof schema.minimum === "number") {
      intSchema = intSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      intSchema = intSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      intSchema = intSchema.multipleOf(schema.multipleOf);
    }
    
    return intSchema;
  }

  // Handle boolean type
  if (schema.type === "boolean") {
    return z.boolean();
  }

  // Handle null type
  if (schema.type === "null") {
    return z.null();
  }

  // Handle anyOf (union types)
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const schemas = schema.anyOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle oneOf (discriminated union)
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const schemas = schema.oneOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle allOf (intersection types)
  if (schema.allOf && Array.isArray(schema.allOf)) {
    // Zod doesn't have native intersection for objects, so merge them
    let merged: z.ZodType<any> = z.object({});
    for (const subSchema of schema.allOf) {
      const zodSchema = jsonSchemaToZod(subSchema);
      merged = (merged as any).and(zodSchema);
    }
    return merged;
  }

  // Handle enum for non-string types
  if (schema.enum && Array.isArray(schema.enum)) {
    if (schema.enum.length === 1) {
      return z.literal(schema.enum[0]);
    }
    // Create union of literals
    const literals = schema.enum.map((val: any) => z.literal(val));
    return z.union(literals as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Default to any
  return z.any();
}

/**
 * Convert native MCP tool definitions to ToolDescriptor format
 * that createCodeTool() expects
 */
function convertMCPToolToDescriptor(toolDef: MCPTool, client: MCPClient, toolName: string, serverName: string): any {
  return {
    description: toolDef.description || "",
    inputSchema: jsonSchemaToZod(toolDef.inputSchema),
    execute: async (args: any) => {
      // Log the tool invocation
      logDebug(`Calling tool: ${serverName}__${toolName}`, {
        component: 'Tool Execution',
        server: serverName,
        tool: toolName,
        args: JSON.stringify(args)
      });

      try {
        // Execute the tool on the upstream server using the MCP client
        const result = await client.callTool(toolName, args);
        
        // Log successful execution
        logDebug(`Tool completed: ${serverName}__${toolName}`, {
          component: 'Tool Execution',
          server: serverName,
          tool: toolName,
          resultType: typeof result,
          resultSize: JSON.stringify(result).length
        });

        return result;
      } catch (error) {
        logDebug(`Tool failed: ${serverName}__${toolName}`, {
          component: 'Tool Execution',
          server: serverName,
          tool: toolName,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
  };
}

export async function startCodeModeBridgeServer(
  serverConfigs: MCPServerConfig[]
) {
  const mcp = new McpServer({
    name: "codemode-bridge",
    version: "1.0.0",
  });

  // Collect all tools from upstream MCP servers using official MCP SDK
  const allToolDescriptors: Record<string, any> = {};
  const mcpClients: MCPClient[] = []; // Keep track of clients for cleanup
  let totalToolCount = 0;

  // Initialize all connections in parallel
  const connectionPromises = serverConfigs.map(async (config) => {
    try {
      // Create client for this upstream MCP server using official SDK
      const client = new MCPClient(config);
      
      // Connect to the upstream server
      await client.connect();
      mcpClients.push(client);

      // Get tools from this server in native MCP format (JSON Schema)
      const serverTools = await client.listTools();
      const toolCount = serverTools.length;
      totalToolCount += toolCount;

      logDebug(
        `Server "${config.name}" has ${toolCount} tools`,
        { component: 'Bridge' }
      );

      // Namespace tools by server name to avoid conflicts
      // e.g., kubernetes.get_pod -> kubernetes__get_pod
      // Convert native MCP tools (JSON Schema) to ToolDescriptor format (Zod)
      for (const tool of serverTools) {
        const namespacedName = `${config.name}__${tool.name}`;
        // Convert the native MCP tool to ToolDescriptor format
        const descriptor = convertMCPToolToDescriptor(tool, client, tool.name, config.name);
        allToolDescriptors[namespacedName] = descriptor;
      }

      return { config: config.name, toolCount, success: true };
    } catch (error) {
      logError(
        `Failed to connect to "${config.name}"`,
        error instanceof Error ? error : { error: String(error) }
      );
      // Continue with other servers instead of failing completely
      return { config: config.name, toolCount: 0, success: false };
    }
  });

  // Wait for all connections to initialize in parallel
  const results = await Promise.all(connectionPromises);

  // Recalculate total tool count from results (in case totalToolCount wasn't updated due to timing)
  totalToolCount = results.reduce((sum, result) => sum + (result?.toolCount || 0), 0);

  logInfo(
    `Total: ${totalToolCount} tools from ${serverConfigs.length} server(s)`,
    { component: 'Bridge' }
  );

  // Create the executor using the codemode SDK pattern
  const executor = createExecutor(30000); // 30 second timeout

  // Create the codemode tool using the codemode SDK
  // Pass ToolDescriptor format (with Zod schemas and execute functions)
  logInfo(
    `Creating codemode tool with tools: ${Object.keys(allToolDescriptors).join(', ')}`,
    { component: 'Bridge' }
  );
  const codemodeTool = createCodeTool({
    tools: allToolDescriptors,
    executor,
    // Let the SDK auto-generate description from available tools
  });

  // Adapt the AI SDK Tool to MCP protocol format and register it
  // The adaptAISDKToolToMCP function handles the protocol conversion
  await adaptAISDKToolToMCP(mcp, codemodeTool);

  // Connect downstream MCP transport (what the client connects to)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  logInfo(`Ready on stdio transport`, { component: 'Code Mode Bridge' });
  logInfo(
    `Connected to: ${serverConfigs.map((s) => s.name).join(", ")}`,
    { component: 'Code Mode Bridge' }
  );
  logInfo(`Exposing single 'codemode' tool`, { component: 'Code Mode Bridge' });
}
