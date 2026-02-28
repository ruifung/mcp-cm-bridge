import {Tool} from "@/tools/Tool.js";
import {z} from "zod";
import {ToolAnnotations} from "@modelcontextprotocol/sdk/types.js";
import {RequestHandlerExtra} from "@modelcontextprotocol/sdk/shared/protocol.js";
import {ServerNotification, ServerRequest} from "@modelcontextprotocol/sdk/types.js";
import {ExecutorInfo, ExecutorTypes} from "@/mcp/executor.js";
import {UpstreamMcpClientManager} from "@/mcp/upstream-mcp-client-manager.js";

const STATUS_TOOL_NAME = "bridge_status";
const STATUS_TOOL_TITLE = "Get Bridge Status";
const STATUS_TOOL_DESCRIPTION = "Return the current status of the codemode bridge, including connected server names and the number of functions each server provides. Use this to see which servers are available before calling sandbox_get_functions.";
const STATUS_TOOL_INPUT_SCHEMA = z.object({}).strict();
const STATUS_TOOL_OUTPUT_SCHEMA = z.object({
    executor: z.object({
        type: z.enum(ExecutorTypes),
        reason: z.string(),
        timeout: z.number()
    }),
    servers: z.array(z.object({
        name: z.string(),
        toolCount: z.number(),
    })),
}).strict();


export class BridgeStatusTool extends Tool<typeof STATUS_TOOL_INPUT_SCHEMA, typeof STATUS_TOOL_OUTPUT_SCHEMA> {
    toolName = STATUS_TOOL_NAME;
    title = STATUS_TOOL_TITLE;
    description = STATUS_TOOL_DESCRIPTION;
    inputSchema = STATUS_TOOL_INPUT_SCHEMA;
    outputSchema = STATUS_TOOL_OUTPUT_SCHEMA;
    annotations: ToolAnnotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true}

    private executorInfo: ExecutorInfo;
    private upstreamManager: UpstreamMcpClientManager;

    constructor(executorInfo: ExecutorInfo, upstreamManager: UpstreamMcpClientManager) {
        super();
        this.executorInfo = executorInfo;
        this.upstreamManager = upstreamManager;
    }

    handler = async (): Promise<any> => {
        const serverInfo = this.upstreamManager.getServerToolInfo();

        const status = {
            executor: {
                type: this.executorInfo.type,
                reason: this.executorInfo.reason,
                timeout: this.executorInfo.timeout,
            },
            servers: serverInfo.map(({name, toolCount}) => ({name, toolCount})),
        };

        return {
            content: [{type: "text" as const, text: JSON.stringify(status, null, 2)}],
            structuredContent: status,
        } as any;
    }
}