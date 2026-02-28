/**
 * Unit tests for ServerManager
 *
 * Tests the lifecycle management of upstream MCP server connections:
 * connecting, disconnecting, tool namespacing, and descriptor merging.
 *
 * MCPClient, jsonSchemaToZod, and logger functions are fully mocked so
 * no real server processes are spawned.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

vi.mock('../../src/mcp/mcp-client.js', () => ({
  MCPClient: vi.fn(),
}));

vi.mock('../../src/mcp/server.js', () => ({
  jsonSchemaToZod: vi.fn((schema: any) => schema),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { ServerManager } from '../../src/mcp/server-manager.js';
import { MCPClient, type MCPServerConfig, type MCPTool } from '../../src/mcp/mcp-client.js';
import { logDebug, logError, logInfo } from '../../src/utils/logger.js';
import { jsonSchemaToZod } from '../../src/mcp/server.js';

// ── Type helpers ──────────────────────────────────────────────────────────────

interface MockMCPClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeConfig = (name = 'test-server'): MCPServerConfig => ({
  name,
  type: 'stdio',
  command: 'echo',
  args: ['hello'],
});

const makeTool = (name: string, description = `${name} description`): MCPTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

/**
 * Build a mock MCPClient instance and wire the MCPClient constructor to return it.
 */
function setupMockClient(tools: MCPTool[] = []): MockMCPClient {
  const mockClient: MockMCPClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: 'result' }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(MCPClient).mockImplementation(function () { return mockClient as any; });
  return mockClient;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ServerManager', () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ServerManager();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ── connectServer ───────────────────────────────────────────────────────────

  describe('connectServer', () => {
    it('should return true when connection and tool listing succeed', async () => {
      setupMockClient([makeTool('search')]);

      const result = await manager.connectServer('my-server', makeConfig('my-server'));

      expect(result).toBe(true);
    });

    it('should create an MCPClient with the provided config', async () => {
      const config = makeConfig('weather-server');
      setupMockClient([]);

      await manager.connectServer('weather-server', config);

      expect(vi.mocked(MCPClient)).toHaveBeenCalledOnce();
      expect(vi.mocked(MCPClient)).toHaveBeenCalledWith(config);
    });

    it('should call connect() then listTools() on the new client', async () => {
      const mockClient = setupMockClient([makeTool('list_files')]);

      await manager.connectServer('fs-server', makeConfig('fs-server'));

      expect(mockClient.connect).toHaveBeenCalledOnce();
      expect(mockClient.listTools).toHaveBeenCalledOnce();
      // connect must be called before listTools
      const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
      const listOrder = mockClient.listTools.mock.invocationCallOrder[0];
      expect(connectOrder).toBeLessThan(listOrder);
    });

    it('should register the server so it appears in getConnectedServerNames()', async () => {
      setupMockClient([]);

      await manager.connectServer('alpha-server', makeConfig('alpha-server'));

      expect(manager.getConnectedServerNames()).toContain('alpha-server');
    });

    it('should namespace tool keys as "<serverName>__<toolName>"', async () => {
      setupMockClient([makeTool('read_file'), makeTool('write_file')]);

      await manager.connectServer('file-svc', makeConfig('file-svc'));

      const descriptors = manager.getAllToolDescriptors();
      expect(descriptors).toHaveProperty('file-svc__read_file');
      expect(descriptors).toHaveProperty('file-svc__write_file');
    });

    it('should not create bare (non-namespaced) tool keys', async () => {
      setupMockClient([makeTool('search')]);

      await manager.connectServer('search-svc', makeConfig('search-svc'));

      const descriptors = manager.getAllToolDescriptors();
      expect(descriptors).not.toHaveProperty('search');
    });

    it('should build a descriptor with description from the tool definition', async () => {
      setupMockClient([makeTool('greet', 'Greets the user warmly')]);

      await manager.connectServer('greeting-svc', makeConfig('greeting-svc'));

      const descriptor = manager.getAllToolDescriptors()['greeting-svc__greet'];
      expect(descriptor.description).toBe('Greets the user warmly');
    });

    it('should use empty string description when tool has no description', async () => {
      const toolWithoutDescription: MCPTool = {
        name: 'silent_tool',
        inputSchema: { type: 'object' },
      };
      setupMockClient([toolWithoutDescription]);

      await manager.connectServer('quiet-svc', makeConfig('quiet-svc'));

      const descriptor = manager.getAllToolDescriptors()['quiet-svc__silent_tool'];
      expect(descriptor.description).toBe('');
    });

    it('should call jsonSchemaToZod with the tool inputSchema', async () => {
      const schema = { type: 'object', properties: { query: { type: 'string' } } };
      setupMockClient([{ name: 'search', description: 'Search', inputSchema: schema }]);

      await manager.connectServer('search-svc', makeConfig('search-svc'));

      expect(vi.mocked(jsonSchemaToZod)).toHaveBeenCalledWith(schema);
    });

    it('should store the result of jsonSchemaToZod as the descriptor inputSchema', async () => {
      const rawSchema = { type: 'object', properties: {} };
      const transformedSchema = { _transformed: true, original: rawSchema };
      vi.mocked(jsonSchemaToZod).mockReturnValueOnce(transformedSchema as any);
      setupMockClient([makeTool('op')]);

      await manager.connectServer('svc', makeConfig('svc'));

      const descriptor = manager.getAllToolDescriptors()['svc__op'];
      expect(descriptor.inputSchema).toBe(transformedSchema);
    });

    it('should return false and not throw when connect() rejects', async () => {
      const mockClient = setupMockClient([]);
      mockClient.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await manager.connectServer('broken-server', makeConfig('broken-server'));

      expect(result).toBe(false);
    });

    it('should return false and not throw when listTools() rejects', async () => {
      const mockClient = setupMockClient([]);
      mockClient.listTools.mockRejectedValueOnce(new Error('Protocol error'));

      const result = await manager.connectServer('flaky-server', makeConfig('flaky-server'));

      expect(result).toBe(false);
    });

    it('should call logError when connection fails', async () => {
      const mockClient = setupMockClient([]);
      mockClient.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await manager.connectServer('bad-server', makeConfig('bad-server'));

      expect(vi.mocked(logError)).toHaveBeenCalledOnce();
    });

    it('should NOT register the server when connection fails', async () => {
      const mockClient = setupMockClient([]);
      mockClient.connect.mockRejectedValueOnce(new Error('Timeout'));

      await manager.connectServer('dead-server', makeConfig('dead-server'));

      expect(manager.getConnectedServerNames()).not.toContain('dead-server');
    });

    it('should handle a server with zero tools', async () => {
      setupMockClient([]);

      const result = await manager.connectServer('empty-svc', makeConfig('empty-svc'));

      expect(result).toBe(true);
      expect(manager.getConnectedServerNames()).toContain('empty-svc');
      expect(manager.getAllToolDescriptors()).toEqual({});
    });

    it('should support connecting multiple servers independently', async () => {
      // First server
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return {
          connect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([makeTool('alpha')]),
          callTool: vi.fn(),
          close: vi.fn(),
        } as any; })
        // Second server
        .mockImplementationOnce(function () { return {
          connect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([makeTool('beta')]),
          callTool: vi.fn(),
          close: vi.fn(),
        } as any; });

      await manager.connectServer('server-a', makeConfig('server-a'));
      await manager.connectServer('server-b', makeConfig('server-b'));

      expect(manager.getConnectedServerNames()).toContain('server-a');
      expect(manager.getConnectedServerNames()).toContain('server-b');
    });

    it('should log info with pluralised tool count when one tool is connected', async () => {
      setupMockClient([makeTool('solo_tool')]);

      await manager.connectServer('one-tool-svc', makeConfig('one-tool-svc'));

      const logInfoCalls = vi.mocked(logInfo).mock.calls;
      const connectMsg = logInfoCalls.find(([msg]) => (msg as string).includes('one-tool-svc'));
      expect(connectMsg).toBeDefined();
      // Singular: "1 tool" not "1 tools"
      expect(connectMsg![0]).toContain('1 tool');
      expect(connectMsg![0]).not.toContain('1 tools');
    });

    it('should log info with pluralised tool count when multiple tools are connected', async () => {
      setupMockClient([makeTool('tool_a'), makeTool('tool_b')]);

      await manager.connectServer('two-tool-svc', makeConfig('two-tool-svc'));

      const logInfoCalls = vi.mocked(logInfo).mock.calls;
      const connectMsg = logInfoCalls.find(([msg]) => (msg as string).includes('two-tool-svc'));
      expect(connectMsg).toBeDefined();
      expect(connectMsg![0]).toContain('2 tools');
    });
  });

  // ── disconnectServer ────────────────────────────────────────────────────────

  describe('disconnectServer', () => {
    it('should call close() on the managed client', async () => {
      const mockClient = setupMockClient([]);
      await manager.connectServer('svc', makeConfig('svc'));

      await manager.disconnectServer('svc');

      expect(mockClient.close).toHaveBeenCalledOnce();
    });

    it('should remove the server from the internal registry', async () => {
      setupMockClient([]);
      await manager.connectServer('transient-svc', makeConfig('transient-svc'));

      await manager.disconnectServer('transient-svc');

      expect(manager.getConnectedServerNames()).not.toContain('transient-svc');
    });

    it('should remove the server tools from getAllToolDescriptors()', async () => {
      setupMockClient([makeTool('my_tool')]);
      await manager.connectServer('disposable-svc', makeConfig('disposable-svc'));

      await manager.disconnectServer('disposable-svc');

      expect(manager.getAllToolDescriptors()).not.toHaveProperty('disposable-svc__my_tool');
    });

    it('should be a no-op for an unknown server name', async () => {
      // Should not throw
      await expect(manager.disconnectServer('nonexistent-server')).resolves.toBeUndefined();
    });

    it('should not call close() when disconnecting a non-existent server', async () => {
      const mockClient = setupMockClient([]);
      // Connect and then disconnect a different name
      await manager.connectServer('real-svc', makeConfig('real-svc'));
      vi.clearAllMocks();

      await manager.disconnectServer('ghost-svc');

      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it('should still remove server from registry when close() throws', async () => {
      const mockClient = setupMockClient([]);
      mockClient.close.mockRejectedValueOnce(new Error('Socket already closed'));
      await manager.connectServer('fragile-svc', makeConfig('fragile-svc'));

      // Must not throw
      await expect(manager.disconnectServer('fragile-svc')).resolves.toBeUndefined();
      expect(manager.getConnectedServerNames()).not.toContain('fragile-svc');
    });

    it('should log at debug level when close() throws', async () => {
      const mockClient = setupMockClient([]);
      mockClient.close.mockRejectedValueOnce(new Error('Broken pipe'));
      await manager.connectServer('leaky-svc', makeConfig('leaky-svc'));

      await manager.disconnectServer('leaky-svc');

      expect(vi.mocked(logDebug)).toHaveBeenCalled();
    });

    it('should log info after successful disconnection', async () => {
      setupMockClient([]);
      await manager.connectServer('bye-svc', makeConfig('bye-svc'));
      vi.mocked(logInfo).mockClear();

      await manager.disconnectServer('bye-svc');

      expect(vi.mocked(logInfo)).toHaveBeenCalled();
      const calls = vi.mocked(logInfo).mock.calls;
      const disconnectMsg = calls.find(([msg]) => (msg as string).includes('bye-svc'));
      expect(disconnectMsg).toBeDefined();
    });
  });

  // ── disconnectAll ───────────────────────────────────────────────────────────

  describe('disconnectAll', () => {
    it('should disconnect all connected servers', async () => {
      // Wire two distinct mock clients
      const clientA = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      const clientB = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };

      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return clientA as any; })
        .mockImplementationOnce(function () { return clientB as any; });

      await manager.connectServer('svc-a', makeConfig('svc-a'));
      await manager.connectServer('svc-b', makeConfig('svc-b'));

      await manager.disconnectAll();

      expect(clientA.close).toHaveBeenCalledOnce();
      expect(clientB.close).toHaveBeenCalledOnce();
    });

    it('should leave getConnectedServerNames() empty after disconnectAll()', async () => {
      const clientA = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      const clientB = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };

      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return clientA as any; })
        .mockImplementationOnce(function () { return clientB as any; });

      await manager.connectServer('svc-x', makeConfig('svc-x'));
      await manager.connectServer('svc-y', makeConfig('svc-y'));

      await manager.disconnectAll();

      expect(manager.getConnectedServerNames()).toHaveLength(0);
    });

    it('should be a no-op when no servers are connected', async () => {
      await expect(manager.disconnectAll()).resolves.toBeUndefined();
      expect(manager.getConnectedServerNames()).toHaveLength(0);
    });

    it('should resolve even if one server close() fails', async () => {
      const goodClient = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      const badClient = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn().mockRejectedValue(new Error('Force close failed')) };

      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return goodClient as any; })
        .mockImplementationOnce(function () { return badClient as any; });

      await manager.connectServer('healthy-svc', makeConfig('healthy-svc'));
      await manager.connectServer('crashing-svc', makeConfig('crashing-svc'));

      await expect(manager.disconnectAll()).resolves.toBeUndefined();
    });
  });

  // ── getAllToolDescriptors ───────────────────────────────────────────────────

  describe('getAllToolDescriptors', () => {
    it('should return an empty object when no servers are connected', () => {
      expect(manager.getAllToolDescriptors()).toEqual({});
    });

    it('should return tools from a single connected server', async () => {
      setupMockClient([makeTool('do_thing')]);

      await manager.connectServer('single-svc', makeConfig('single-svc'));

      const descriptors = manager.getAllToolDescriptors();
      expect(Object.keys(descriptors)).toHaveLength(1);
      expect(descriptors).toHaveProperty('single-svc__do_thing');
    });

    it('should merge tools from multiple connected servers into a flat object', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return {
          connect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([makeTool('search'), makeTool('index')]),
          callTool: vi.fn(),
          close: vi.fn(),
        } as any; })
        .mockImplementationOnce(function () { return {
          connect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([makeTool('send_email')]),
          callTool: vi.fn(),
          close: vi.fn(),
        } as any; });

      await manager.connectServer('search-svc', makeConfig('search-svc'));
      await manager.connectServer('email-svc', makeConfig('email-svc'));

      const descriptors = manager.getAllToolDescriptors();
      expect(descriptors).toHaveProperty('search-svc__search');
      expect(descriptors).toHaveProperty('search-svc__index');
      expect(descriptors).toHaveProperty('email-svc__send_email');
      expect(Object.keys(descriptors)).toHaveLength(3);
    });

    it('should return a new object on each call (not a cached reference)', async () => {
      setupMockClient([makeTool('ping')]);
      await manager.connectServer('ping-svc', makeConfig('ping-svc'));

      const first = manager.getAllToolDescriptors();
      const second = manager.getAllToolDescriptors();

      expect(first).not.toBe(second);
    });

    it('should reflect disconnections — removed server tools are absent', async () => {
      const clientA = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([makeTool('tool_a')]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      const clientB = { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([makeTool('tool_b')]), callTool: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };

      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return clientA as any; })
        .mockImplementationOnce(function () { return clientB as any; });

      await manager.connectServer('svc-a', makeConfig('svc-a'));
      await manager.connectServer('svc-b', makeConfig('svc-b'));

      await manager.disconnectServer('svc-a');

      const descriptors = manager.getAllToolDescriptors();
      expect(descriptors).not.toHaveProperty('svc-a__tool_a');
      expect(descriptors).toHaveProperty('svc-b__tool_b');
    });
  });

  // ── getConnectedServerNames ─────────────────────────────────────────────────

  describe('getConnectedServerNames', () => {
    it('should return an empty array when no servers are connected', () => {
      expect(manager.getConnectedServerNames()).toEqual([]);
    });

    it('should return the name of each connected server', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn() } as any; })
        .mockImplementationOnce(function () { return { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn(), close: vi.fn() } as any; });

      await manager.connectServer('galactica', makeConfig('galactica'));
      await manager.connectServer('andromeda', makeConfig('andromeda'));

      const names = manager.getConnectedServerNames();
      expect(names).toContain('galactica');
      expect(names).toContain('andromeda');
      expect(names).toHaveLength(2);
    });

    it('should exclude failed connections', async () => {
      const mockClient = setupMockClient([]);
      mockClient.connect.mockRejectedValueOnce(new Error('Refused'));

      await manager.connectServer('unreachable-svc', makeConfig('unreachable-svc'));

      expect(manager.getConnectedServerNames()).not.toContain('unreachable-svc');
    });

    it('should not include a server after it has been disconnected', async () => {
      setupMockClient([]);
      await manager.connectServer('ephemeral-svc', makeConfig('ephemeral-svc'));
      await manager.disconnectServer('ephemeral-svc');

      expect(manager.getConnectedServerNames()).not.toContain('ephemeral-svc');
    });
  });

  // ── getServerToolInfo ───────────────────────────────────────────────────────

  describe('getServerToolInfo', () => {
    it('should return an empty array when no servers are connected', () => {
      expect(manager.getServerToolInfo()).toEqual([]);
    });

    it('should return one entry per connected server', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () { return { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([makeTool('t1')]), callTool: vi.fn(), close: vi.fn() } as any; })
        .mockImplementationOnce(function () { return { connect: vi.fn().mockResolvedValue(undefined), listTools: vi.fn().mockResolvedValue([makeTool('t2'), makeTool('t3')]), callTool: vi.fn(), close: vi.fn() } as any; });

      await manager.connectServer('svc-1', makeConfig('svc-1'));
      await manager.connectServer('svc-2', makeConfig('svc-2'));

      const info = manager.getServerToolInfo();
      expect(info).toHaveLength(2);
    });

    it('should report the correct name for each server entry', async () => {
      setupMockClient([makeTool('ping')]);
      await manager.connectServer('ping-server', makeConfig('ping-server'));

      const info = manager.getServerToolInfo();
      expect(info[0].name).toBe('ping-server');
    });

    it('should report the correct toolCount for each server', async () => {
      setupMockClient([makeTool('a'), makeTool('b'), makeTool('c')]);
      await manager.connectServer('three-tool-svc', makeConfig('three-tool-svc'));

      const info = manager.getServerToolInfo();
      expect(info[0].toolCount).toBe(3);
    });

    it('should list namespaced tool names in the tools array', async () => {
      setupMockClient([makeTool('create_record'), makeTool('delete_record')]);
      await manager.connectServer('db-svc', makeConfig('db-svc'));

      const info = manager.getServerToolInfo();
      expect(info[0].tools).toContain('db-svc__create_record');
      expect(info[0].tools).toContain('db-svc__delete_record');
    });

    it('should report toolCount of 0 for a server with no tools', async () => {
      setupMockClient([]);
      await manager.connectServer('bare-svc', makeConfig('bare-svc'));

      const info = manager.getServerToolInfo();
      expect(info[0].toolCount).toBe(0);
      expect(info[0].tools).toEqual([]);
    });
  });

  // ── Tool execute (ToolDescriptor.execute) ───────────────────────────────────

  describe('ToolDescriptor.execute', () => {
    it('should call client.callTool() with the original tool name (not namespaced)', async () => {
      const mockClient = setupMockClient([makeTool('list_users')]);
      await manager.connectServer('user-svc', makeConfig('user-svc'));

      const descriptor = manager.getAllToolDescriptors()['user-svc__list_users'];
      await descriptor.execute({ limit: 10 });

      expect(mockClient.callTool).toHaveBeenCalledWith('list_users', { limit: 10 });
    });

    it('should return the result from client.callTool()', async () => {
      const mockClient = setupMockClient([makeTool('get_weather')]);
      const expectedResult = { temperature: 22, unit: 'celsius', city: 'Berlin' };
      mockClient.callTool.mockResolvedValueOnce(expectedResult);
      await manager.connectServer('weather-svc', makeConfig('weather-svc'));

      const descriptor = manager.getAllToolDescriptors()['weather-svc__get_weather'];
      const result = await descriptor.execute({ city: 'Berlin' });

      expect(result).toEqual(expectedResult);
    });

    it('should propagate errors thrown by client.callTool()', async () => {
      const mockClient = setupMockClient([makeTool('risky_op')]);
      const upstreamError = new Error('Upstream service unavailable');
      mockClient.callTool.mockRejectedValueOnce(upstreamError);
      await manager.connectServer('risky-svc', makeConfig('risky-svc'));

      const descriptor = manager.getAllToolDescriptors()['risky-svc__risky_op'];

      await expect(descriptor.execute({})).rejects.toThrow('Upstream service unavailable');
    });

    it('should re-throw the exact same error instance from callTool()', async () => {
      const mockClient = setupMockClient([makeTool('precise_op')]);
      const specificError = new TypeError('Invalid argument type');
      mockClient.callTool.mockRejectedValueOnce(specificError);
      await manager.connectServer('precise-svc', makeConfig('precise-svc'));

      const descriptor = manager.getAllToolDescriptors()['precise-svc__precise_op'];

      await expect(descriptor.execute({ value: null })).rejects.toBe(specificError);
    });

    it('should pass args through unchanged to callTool()', async () => {
      const mockClient = setupMockClient([makeTool('complex_op')]);
      await manager.connectServer('complex-svc', makeConfig('complex-svc'));

      const complexArgs = {
        filters: { status: 'active', role: 'admin' },
        pagination: { page: 3, size: 50 },
        sortBy: ['createdAt', 'name'],
      };

      const descriptor = manager.getAllToolDescriptors()['complex-svc__complex_op'];
      await descriptor.execute(complexArgs);

      expect(mockClient.callTool).toHaveBeenCalledWith('complex_op', complexArgs);
    });

    it('should log debug before and after successful callTool()', async () => {
      setupMockClient([makeTool('trace_op')]);
      await manager.connectServer('trace-svc', makeConfig('trace-svc'));
      vi.mocked(logDebug).mockClear();

      const descriptor = manager.getAllToolDescriptors()['trace-svc__trace_op'];
      await descriptor.execute({});

      // At least two debug calls: one before execution, one after
      expect(vi.mocked(logDebug).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should log debug when callTool() throws', async () => {
      const mockClient = setupMockClient([makeTool('fail_op')]);
      mockClient.callTool.mockRejectedValueOnce(new Error('Network timeout'));
      await manager.connectServer('fail-svc', makeConfig('fail-svc'));
      vi.mocked(logDebug).mockClear();

      const descriptor = manager.getAllToolDescriptors()['fail-svc__fail_op'];
      await descriptor.execute({}).catch(() => undefined);

      // At least one debug log entry about the failure
      expect(vi.mocked(logDebug).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('should be callable independently by each namespaced tool key', async () => {
      const mockClient = setupMockClient([makeTool('op_one'), makeTool('op_two')]);
      await manager.connectServer('multi-svc', makeConfig('multi-svc'));

      const descriptors = manager.getAllToolDescriptors();
      await descriptors['multi-svc__op_one'].execute({ x: 1 });
      await descriptors['multi-svc__op_two'].execute({ y: 2 });

      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
      expect(mockClient.callTool).toHaveBeenCalledWith('op_one', { x: 1 });
      expect(mockClient.callTool).toHaveBeenCalledWith('op_two', { y: 2 });
    });
  });
});
