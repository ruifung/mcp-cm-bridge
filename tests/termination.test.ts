import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCodeModeBridgeServer, type MCPServerConfig } from '../src/mcp/server.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createExecutor } from "../src/mcp/executor.js";
import { MCPClient } from "../src/mcp/mcp-client.js";

// Mock the dependencies
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  const McpServer = vi.fn();
  McpServer.prototype.registerTool = vi.fn();
  McpServer.prototype.connect = vi.fn().mockResolvedValue(undefined);
  return { McpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  const StdioServerTransport = vi.fn();
  StdioServerTransport.prototype.close = vi.fn().mockResolvedValue(undefined);
  return { StdioServerTransport };
});

vi.mock("../src/mcp/executor.js", () => {
  return {
    createExecutor: vi.fn().mockResolvedValue({
      executor: {
        execute: vi.fn().mockResolvedValue("startup test"),
        dispose: vi.fn(),
      },
      info: { type: "mock", reason: "test", timeout: 30000 },
    }),
  };
});

vi.mock("../src/mcp/mcp-client.js", () => {
  const MCPClient = vi.fn();
  MCPClient.prototype.connect = vi.fn().mockResolvedValue(undefined);
  MCPClient.prototype.listTools = vi.fn().mockResolvedValue([]);
  MCPClient.prototype.close = vi.fn().mockResolvedValue(undefined);
  return { MCPClient };
});

vi.mock("../src/mcp/mcp-adapter.js", () => {
  return {
    adaptAISDKToolToMCP: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@cloudflare/codemode/ai", () => {
  return {
    createCodeTool: vi.fn().mockReturnValue({}),
  };
});

describe('MCP Server Termination', () => {
  let exitSpy: any;
  let stdinOnSpy: any;
  let processOnSpy: any;
  let handlers: Record<string, Function> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    
    // Spy on process.exit but prevent it from actually exiting
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    
    // Mock process.stdin.on to capture handlers
    stdinOnSpy = vi.spyOn(process.stdin, 'on').mockImplementation((event, handler) => {
      handlers[`stdin:${String(event)}`] = handler;
      return process.stdin;
    });

    // Mock process.on to capture handlers
    processOnSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers[String(event)] = handler;
      return process;
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdinOnSpy.mockRestore();
    processOnSpy.mockRestore();
  });

  it('should shut down when process.stdin emits end', async () => {
    await startCodeModeBridgeServer([], 'vm2');
    
    expect(handlers['stdin:end']).toBeDefined();
    
    // Trigger the handler
    await handlers['stdin:end']();
    
    // Verify cleanup
    const transportInstance = vi.mocked(StdioServerTransport).mock.instances[0];
    expect(transportInstance.close).toHaveBeenCalled();
    
    const { executor } = await vi.mocked(createExecutor).mock.results[0].value;
    expect(executor.dispose).toHaveBeenCalled();
    
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should shut down when process.stdin emits close', async () => {
    await startCodeModeBridgeServer([], 'vm2');
    
    expect(handlers['stdin:close']).toBeDefined();
    
    // Trigger the handler
    await handlers['stdin:close']();
    
    const transportInstance = vi.mocked(StdioServerTransport).mock.instances[0];
    expect(transportInstance.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should shut down when SIGINT is received', async () => {
    await startCodeModeBridgeServer([], 'vm2');
    
    expect(handlers['SIGINT']).toBeDefined();
    
    // Trigger the handler
    await handlers['SIGINT']();
    
    const transportInstance = vi.mocked(StdioServerTransport).mock.instances[0];
    expect(transportInstance.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should shut down when SIGTERM is received', async () => {
    await startCodeModeBridgeServer([], 'vm2');
    
    expect(handlers['SIGTERM']).toBeDefined();
    
    // Trigger the handler
    await handlers['SIGTERM']();
    
    const transportInstance = vi.mocked(StdioServerTransport).mock.instances[0];
    expect(transportInstance.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should close all upstream MCP clients on shutdown', async () => {
    const configs: MCPServerConfig[] = [
      { name: 'server1', type: 'stdio', command: 'node', args: [] },
      { name: 'server2', type: 'stdio', command: 'node', args: [] }
    ];
    
    await startCodeModeBridgeServer(configs, 'vm2');
    
    // Trigger shutdown
    await handlers['SIGINT']();
    
    // Verify all clients were closed
    const clientInstances = vi.mocked(MCPClient).mock.instances;
    expect(clientInstances).toHaveLength(2);
    clientInstances.forEach(instance => {
      expect(instance.close).toHaveBeenCalled();
    });
    
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

