import {Tool} from "./Tool.js";
import {z} from "zod";
import {RequestHandlerExtra} from "@modelcontextprotocol/sdk/shared/protocol.js";
import {ServerNotification, ServerRequest} from "@modelcontextprotocol/sdk/types.js";
import {SessionResolver} from "@/mcp/session-resolver.js";
import {SandboxManager} from "@/sandbox/manager.js";


const EVAL_TOOL_NAME = "sandbox_eval_js";
const EVAL_TOOL_TITLE = "Run Code in Sandbox"
const EVAL_TOOL_DESCRIPTION = `Execute JavaScript code in a sandboxed environment. Use this to call upstream functions exposed on the codemode object. Other sandbox_* tools are for discovery only and are called directly as tools, not from inside this code.
Before writing code, follow this sequence:
1. Discover: call sandbox_search_functions or sandbox_get_functions to find the function you need.
2. Inspect: call sandbox_get_function_schema to get the exact TypeScript signature and parameter types.
3. Execute: call this tool with code that uses the codemode object to invoke those functions.

The code parameter accepts one of two formats. Do not mix them.

Format A — Bare statements. Write one or more JavaScript statements. They will be wrapped in an async function automatically. You can use await freely. To produce output, either use an explicit return statement, or let the last expression be the value you want returned (it is returned automatically). If you do not return a value and there is no final expression, the result is null.

  const result = await codemode.server_name__function_name({ param: "value" });
  return { type: "json", value: result };

Format B — A complete async arrow function expression. The entire input must be the function; do not include any other top-level statements. You must use an explicit return statement.

  async () => {
    const result = await codemode.server_name__function_name({ param: "value" });
    return { type: "json", value: result };
  }

The sandbox provides only the codemode object. No other APIs are available: no filesystem functions, no network functions, no require() or import statements. The only callable functions are properties on the codemode object.

REQUIRED RETURN TYPE — scripts MUST return an EvalReturn value. Plain values are not accepted.

  type EvalReturn =
    | { type: "text"; text: string }                    // plain text output
    | { type: "image"; data: string; mimeType: string } // base64-encoded image
    | { type: "audio"; data: string; mimeType: string } // base64-encoded audio
    | { type: "json"; value: unknown }                  // any JSON-serializable value
    | EvalReturn[];                                     // multiple content blocks

Examples of valid return values:
  return { type: "json", value: result };
  return { type: "text", text: "done" };
  return { type: "image", data: base64String, mimeType: "image/png" };
  return [{ type: "text", text: "summary" }, { type: "json", value: details }];

Returning a plain value (e.g. \`return result\`) will cause a validation error.`;
const EVAL_TOOL_INPUT_SCHEMA = z.object({
    code: z.string().describe("JavaScript code to execute. Provide either bare statements (auto-wrapped in an async function) or a complete async () => { ... } arrow function expression. If the input starts with async () =>, the entire input must be that function. Do not combine both formats in one call."),
}).strict();

export class SandboxEvalTool extends Tool<typeof EVAL_TOOL_INPUT_SCHEMA, undefined> {
    toolName = EVAL_TOOL_NAME;
    title = EVAL_TOOL_TITLE;
    description = EVAL_TOOL_DESCRIPTION;
    inputSchema = EVAL_TOOL_INPUT_SCHEMA;

    sessionResolver: SessionResolver
    sandboxManager: SandboxManager

    constructor(
        sessionResolver: SessionResolver,
        sandboxManager: SandboxManager
    ) {
        super();
        this.sessionResolver = sessionResolver;
        this.sandboxManager = sandboxManager;
    }

    handler = async (args: {
        code: string;
    }, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<any> => {
        const sessionId = extra?.sessionId as string | undefined;
        const executor = await this.sessionResolver.resolve(sessionId);

        const executeResult = await this.sandboxManager.runCodeWithExecutor(executor, args.code);

        if (executeResult.error) {
            const logCtx = executeResult.logs?.length
                ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
                : "";
            throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
        }

        const raw = executeResult.result;

        // Validate the return value against EvalReturn
        if (!isValidEvalReturn(raw)) {
            const received = raw === null ? "null"
                : Array.isArray(raw) ? `array(${(raw as unknown[]).length})`
                    : typeof raw === "object" ? `object with keys: ${Object.keys(raw as object).join(", ") || "(none)"}`
                        : typeof raw;
            const errorText =
                `sandbox_eval_js: script returned an invalid value.\n\n` +
                `Received: ${received}\n\n` +
                `Scripts MUST return an EvalReturn value. Wrap your result like this:\n\n` +
                `  return { type: "json", value: result };\n\n` +
                `The full EvalReturn type is:\n` +
                `  type EvalReturn =\n` +
                `    | { type: "text"; text: string }\n` +
                `    | { type: "image"; data: string; mimeType: string }\n` +
                `    | { type: "audio"; data: string; mimeType: string }\n` +
                `    | { type: "json"; value: unknown }\n` +
                `    | EvalReturn[];`;
            const logCtx = executeResult.logs?.length
                ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
                : "";
            return {
                content: [{type: "text" as const, text: errorText + logCtx}],
                isError: true,
            };
        }

        const mapped = mapEvalReturnToContent(raw);

        if (executeResult.logs?.length) {
            mapped.content.push({
                type: "text",
                text: `\n\nConsole output:\n${executeResult.logs.join("\n")}`,
            });
        }

        return {
            content: mapped.content,
            isError: false,
        } as any;
    }
}

// ── EvalReturn validation and mapping ────────────────────────────────────────

/**
 * The required return type for sandbox_eval_js scripts.
 * Plain values are not accepted — all returns must conform to this shape.
 */
export type EvalReturn =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
    | { type: "json"; value: unknown }
    | EvalReturn[];

/**
 * Validate that a value conforms to EvalReturn.
 * Returns true if valid, false otherwise.
 */
export function isValidEvalReturn(value: unknown): value is EvalReturn {
    if (Array.isArray(value)) {
        return value.every(isValidEvalReturn);
    }
    if (value === null || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    switch (obj["type"]) {
        case "text":
            return typeof obj["text"] === "string";
        case "image":
        case "audio":
            return typeof obj["data"] === "string" && typeof obj["mimeType"] === "string";
        case "json":
            return "value" in obj;
        default:
            return false;
    }
}


type McpContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string };

/**
 * Map a validated EvalReturn value to an array of MCP content blocks.
 * JSON variants are serialised to text content blocks.
 */
export function mapEvalReturnToContent(
    evalReturn: EvalReturn
): { content: McpContentBlock[] } {
    const items: Exclude<EvalReturn, EvalReturn[]>[] = Array.isArray(evalReturn)
        ? evalReturn as Exclude<EvalReturn, EvalReturn[]>[]
        : [evalReturn as Exclude<EvalReturn, EvalReturn[]>];

    const content: McpContentBlock[] = [];

    for (const item of items) {
        switch (item.type) {
            case "text":
                content.push({type: "text", text: item.text});
                break;
            case "image":
                content.push({type: "image", data: item.data, mimeType: item.mimeType});
                break;
            case "audio":
                content.push({type: "audio", data: item.data, mimeType: item.mimeType});
                break;
            case "json":
                content.push({type: "text", text: JSON.stringify(item.value, null, 2)});
                break;
        }
    }

    return {content};
}