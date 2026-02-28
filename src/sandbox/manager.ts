import {ExecuteResult, Executor} from "./executor/helpers/types.js";
import {ToolDescriptor} from "@/mcp/upstream-mcp-client-manager.js";
import {normalizeCode, sanitizeToolName} from "@/mcp/schema-utils.js";

export type SandboxFunction = (args: any) => Promise<any>

export class SandboxManager {
    private _registry: Record<string, Record<string, ToolDescriptor>> = {};

    private getRegistryNamespace(namespace: string): Record<string, ToolDescriptor> {
        let registryNamespace = this._registry[sanitizeToolName(namespace)]
        if (registryNamespace === undefined) {
            registryNamespace = {}
            this._registry[namespace] = registryNamespace;
        }
        return registryNamespace
    }

    private clearNamespace(namespace: string) {
        delete this._registry[sanitizeToolName(namespace)]
    }

    private prepareSandboxFunctionList(): Record<string, SandboxFunction> {
        const output: Record<string, SandboxFunction> = {};
        for (const namespace in this._registry) {
            const registryNamespace = this._registry[namespace];
            for (const fnName in registryNamespace) {
                const tool = registryNamespace[fnName];
                const finalFunctionName = `${namespace}__${fnName}`;
                output[finalFunctionName] = tool.execute;
            }
        }
        return output;
    }

    public registerToolDescriptor(namespace: string, tool: ToolDescriptor) {
        this.getRegistryNamespace(namespace)[sanitizeToolName(tool.name)] = tool;
    }

    public registerToolDescriptors(namespace: string, tools: ToolDescriptor[]): void {
        const namespaceRecord = this.getRegistryNamespace(namespace);
        for (const tool of tools) {
            namespaceRecord[sanitizeToolName(tool.name)] = tool;
        }
    }

    public unregisterToolDescriptors(namespace: string, tools: ToolDescriptor[]): void {
        const namespaceRecord = this.getRegistryNamespace(namespace);
        for (const tool of tools) {
            delete namespaceRecord[sanitizeToolName(tool.name)];
        }
        if (Object.keys(namespaceRecord).length === 0) {
            this.clearNamespace(namespace);
        }
    }

    public getToolList(namespace?: string): Array<{ namespace: string, name: string, description: string }> {
        const results: Array<{ namespace: string, name: string, description: string }> = [];
        if (namespace != undefined) {
            return Object.entries(this.getRegistryNamespace(namespace)).map(([name, descriptor]) => {
                const description = descriptor.description;
                return {namespace, name, description};
            })
        } else {
            return Object.entries(this._registry)
                .flatMap(([namespace, namespaceRecord]) => {
                    return Object.entries(namespaceRecord).map(([name, descriptor]) => {
                        const description = descriptor.description;
                        return {namespace, name, description};
                    })
                })
        }
    }

    public getRegisteredTool(namespace: string, name: string): ToolDescriptor|undefined {
        return this.getRegistryNamespace(namespace)[sanitizeToolName(name)];
    }

    public getNamespaceInfo(): Array<{namespace: string, toolCount: number, tools: string[]}> {
        return Object.entries(this._registry).map(([namespace, record]) => {
            const toolCount = Object.keys(record).length
            const tools = Object.keys(record)
            return {namespace, toolCount, tools}
        })
    }

    public runCodeWithExecutor(executor: Executor, code: string): Promise<ExecuteResult> {
        return executor.execute(normalizeCode(code), this.prepareSandboxFunctionList());
    }
}