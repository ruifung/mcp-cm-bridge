/**
 * Unit tests for ServerManager.getToolList() and ServerManager.getToolByName()
 *
 * Tests cover:
 *
 * getToolList():
 *  - Returns entries whose `name` is the sanitized callable form (not the raw
 *    namespaced key)
 *  - When a serverName filter is supplied, only that server's tools are returned
 *  - When no serverName filter is supplied, tools from all servers are returned
 *  - Returns an empty array when no servers are connected
 *  - Each entry carries the correct `server` and `description` fields
 *
 * getToolByName():
 *  - Lookup by the sanitized name (as returned by getToolList()) succeeds
 *  - Lookup by the raw namespaced key (e.g. "my-server__my_tool") returns
 *    undefined — that is not the public API
 *  - Lookup of a completely unknown name returns undefined
 *  - Returns the correct descriptor for a tool on any of several connected servers
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('../../src/mcp/mcp-client.js', () => ({
  MCPClient: vi.fn(),
}));

vi.mock('../../src/mcp/schema-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/schema-utils.js')>();
  return {
    ...actual,
    jsonSchemaToZod: vi.fn((schema: any) => schema),
  };
});

vi.mock('@cloudflare/codemode', () => ({
  sanitizeToolName: (name: string) => {
    if (!name) return '_';
    let s = name.replace(/[-.\s]/g, '_');
    s = s.replace(/[^a-zA-Z0-9_$]/g, '');
    if (!s) return '_';
    if (/^[0-9]/.test(s)) s = '_' + s;
    return s;
  },
  generateTypes: vi.fn(() => '/* mocked schema */'),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { UpstreamMcpClientManager } from '../../src/mcp/upstream-mcp-client-manager.js';
import { MCPClient, type MCPServerConfig, type MCPTool } from '../../src/mcp/mcp-client.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeConfig = (name = 'test-server'): MCPServerConfig => ({
  name,
  type: 'stdio',
  command: 'echo',
  args: ['hello'],
});

const makeTool = (name: string, description = `${name} performs an operation`): MCPTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

function setupMockClient(tools: MCPTool[]): void {
  vi.mocked(MCPClient).mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue(tools),
      callTool: vi.fn().mockResolvedValue({ content: 'result' }),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ServerManager', () => {
  let manager: UpstreamMcpClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new UpstreamMcpClientManager();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ── getToolList() ───────────────────────────────────────────────────────────

  describe('getToolList()', () => {
    it('should return an empty array when no servers are connected', () => {
      expect(manager.getToolList()).toEqual([]);
    });

    it('should return entries with the sanitized `name`, not the raw namespaced key', async () => {
      // Server name "my-server" contains a hyphen; sanitizeToolName replaces it with "_"
      // so "my-server__list_items" → "my_server__list_items"
      setupMockClient([makeTool('list_items')]);
      await manager.connectServer('my-server', makeConfig('my-server'));

      const entries = manager.getToolList();
      expect(entries).toHaveLength(1);

      const rawKey = 'my-server__list_items';
      const sanitizedName = 'my_server__list_items';
      expect(entries[0].name).toBe(sanitizedName);
      expect(entries[0].name).not.toBe(rawKey);
    });

    it('should include the correct `server` field for each entry', async () => {
      setupMockClient([makeTool('search_documents')]);
      await manager.connectServer('elasticsearch', makeConfig('elasticsearch'));

      const entries = manager.getToolList();
      expect(entries[0].server).toBe('elasticsearch');
    });

    it('should include the correct `description` field for each entry', async () => {
      setupMockClient([makeTool('send_notification', 'Sends a push notification to a device')]);
      await manager.connectServer('push-svc', makeConfig('push-svc'));

      const entries = manager.getToolList();
      expect(entries[0].description).toBe('Sends a push notification to a device');
    });

    it('should return all tools from all servers when no filter is applied', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('list_prs'), makeTool('merge_pr')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        })
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('create_issue')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        });

      await manager.connectServer('github', makeConfig('github'));
      await manager.connectServer('jira', makeConfig('jira'));

      const entries = manager.getToolList();
      // 2 from github + 1 from jira
      expect(entries).toHaveLength(3);
      const names = entries.map((e) => e.name);
      expect(names).toContain('github__list_prs');
      expect(names).toContain('github__merge_pr');
      expect(names).toContain('jira__create_issue');
    });

    it('should return only the specified server\'s tools when a serverName filter is given', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('list_repos'), makeTool('clone_repo')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        })
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('send_message')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        });

      await manager.connectServer('github', makeConfig('github'));
      await manager.connectServer('slack', makeConfig('slack'));

      const githubEntries = manager.getToolList('github');
      expect(githubEntries).toHaveLength(2);
      for (const entry of githubEntries) {
        expect(entry.server).toBe('github');
      }
    });

    it('should return no tools when the serverName filter matches no connected server', async () => {
      setupMockClient([makeTool('ping')]);
      await manager.connectServer('health-svc', makeConfig('health-svc'));

      const filtered = manager.getToolList('nonexistent-server');
      expect(filtered).toEqual([]);
    });

    it('should exclude tools from other servers when a serverName filter is given', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('query_database')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        })
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('get_metrics')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        });

      await manager.connectServer('postgres', makeConfig('postgres'));
      await manager.connectServer('prometheus', makeConfig('prometheus'));

      const entries = manager.getToolList('postgres');
      const names = entries.map((e) => e.name);
      expect(names).not.toContain('prometheus__get_metrics');
    });

    it('should handle a server with zero tools gracefully', async () => {
      setupMockClient([]);
      await manager.connectServer('empty-svc', makeConfig('empty-svc'));

      expect(manager.getToolList()).toEqual([]);
      expect(manager.getToolList('empty-svc')).toEqual([]);
    });

    it('should sanitize tool names with special characters in the server name', async () => {
      // Server names can include hyphens, which sanitizeToolName converts to underscores
      setupMockClient([makeTool('fetch_user')]);
      await manager.connectServer('user-service', makeConfig('user-service'));

      const entries = manager.getToolList();
      // "user-service__fetch_user" → "user_service__fetch_user"
      expect(entries[0].name).toBe('user_service__fetch_user');
    });
  });

  // ── getToolByName() ─────────────────────────────────────────────────────────

  describe('getToolByName()', () => {
    it('should return the descriptor when looking up by sanitized name', async () => {
      setupMockClient([makeTool('list_clusters', 'Lists Kubernetes clusters')]);
      await manager.connectServer('k8s', makeConfig('k8s'));

      // Sanitized name: "k8s__list_clusters" (no special chars to replace)
      const descriptor = manager.getToolByName('k8s__list_clusters');
      expect(descriptor).toBeDefined();
    });

    it('should return a descriptor with the correct description', async () => {
      setupMockClient([makeTool('deploy_app', 'Deploys an application to production')]);
      await manager.connectServer('argocd', makeConfig('argocd'));

      const descriptor = manager.getToolByName('argocd__deploy_app');
      expect(descriptor?.description).toBe('Deploys an application to production');
    });

    it('should return undefined when looking up by the raw namespaced key containing hyphens', async () => {
      // Server name "my-svc" → namespaced key is "my-svc__do_work"
      // Sanitized name is "my_svc__do_work"
      // getToolByName("my-svc__do_work") should NOT find it
      setupMockClient([makeTool('do_work')]);
      await manager.connectServer('my-svc', makeConfig('my-svc'));

      const rawKey = 'my-svc__do_work';
      expect(manager.getToolByName(rawKey)).toBeUndefined();
    });

    it('should succeed when looking up by the sanitized name (hyphens replaced)', async () => {
      setupMockClient([makeTool('do_work')]);
      await manager.connectServer('my-svc', makeConfig('my-svc'));

      // Sanitized: "my_svc__do_work"
      const descriptor = manager.getToolByName('my_svc__do_work');
      expect(descriptor).toBeDefined();
    });

    it('should return undefined for a completely unknown name', async () => {
      setupMockClient([makeTool('known_tool')]);
      await manager.connectServer('known-svc', makeConfig('known-svc'));

      expect(manager.getToolByName('does_not_exist')).toBeUndefined();
    });

    it('should return undefined when no servers are connected', () => {
      expect(manager.getToolByName('any__tool')).toBeUndefined();
    });

    it('should find the correct tool from the matching server when multiple servers are connected', async () => {
      vi.mocked(MCPClient)
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('create_mr', 'Opens a merge request')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        })
        .mockImplementationOnce(function () {
          return {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([makeTool('create_ticket', 'Opens a Jira ticket')]),
            callTool: vi.fn(),
            close: vi.fn(),
          } as any;
        });

      await manager.connectServer('gitlab', makeConfig('gitlab'));
      await manager.connectServer('jira', makeConfig('jira'));

      const mrDescriptor = manager.getToolByName('gitlab__create_mr');
      expect(mrDescriptor).toBeDefined();
      expect(mrDescriptor?.description).toBe('Opens a merge request');

      const ticketDescriptor = manager.getToolByName('jira__create_ticket');
      expect(ticketDescriptor).toBeDefined();
      expect(ticketDescriptor?.description).toBe('Opens a Jira ticket');
    });

    it('should return undefined for a tool that was removed via disconnectServer()', async () => {
      setupMockClient([makeTool('ping')]);
      await manager.connectServer('health-svc', makeConfig('health-svc'));

      // Confirm it's reachable before disconnect
      expect(manager.getToolByName('health_svc__ping')).toBeDefined();

      await manager.disconnectServer('health-svc');

      expect(manager.getToolByName('health_svc__ping')).toBeUndefined();
    });

    it('should return a descriptor whose execute function is callable', async () => {
      setupMockClient([makeTool('list_users')]);
      await manager.connectServer('user-api', makeConfig('user-api'));

      const descriptor = manager.getToolByName('user_api__list_users');
      expect(descriptor).toBeDefined();
      expect(typeof descriptor?.execute).toBe('function');
    });
  });
});
