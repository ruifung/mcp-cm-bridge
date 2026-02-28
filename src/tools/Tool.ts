import {McpServer, RegisteredTool, ToolCallback} from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolInputArgs = ZodRawShapeCompat | AnySchema | undefined;
export type ToolOutputArgs = ZodRawShapeCompat | AnySchema | undefined;

export abstract class Tool<INPUT extends ToolInputArgs, OUTPUT extends ToolOutputArgs> {
    abstract toolName: string;
    abstract title: string;
    abstract description: string;
    inputSchema?: INPUT;
    outputSchema?: OUTPUT;
    annotations?: ToolAnnotations;
    meta?: Record<string, unknown>;

    abstract handler: ToolCallback<INPUT>;

    registerWithMcpServer(server: McpServer): RegisteredTool {
        return server.registerTool(
            this.toolName,
            {
                title: this.title,
                description: this.description,
                inputSchema: this.inputSchema,
                outputSchema: this.outputSchema,
                annotations: this.annotations,
                _meta: this.meta,
            },
            this.handler
        )
    }
}
