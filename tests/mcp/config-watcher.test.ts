/**
 * Unit tests for ConfigWatcher
 *
 * Tests cover:
 *  - start(): creates FileWatcher, snapshots initial config
 *  - stop(): closes FileWatcher
 *  - Config diffing: server added, removed, changed, unchanged
 *  - serverFilter: only manages filtered servers
 *  - Invalid JSON on reload: graceful degradation with warning log
 *  - Reload guard: skips concurrent reloads
 *  - Per-server connection error: other servers still connect, callback still invoked
 *  - onServersChanged callback: invoked after all connect/disconnect operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigWatcher, type ConfigWatcherOptions } from '../../src/mcp/config-watcher.js';
import { FileWatcher } from '../../src/utils/file-watcher.js';
import { loadMCPConfigFile, getServerConfig, type MCPJsonConfig } from '../../src/mcp/config.js';
import { logDebug, logInfo, logWarn } from '../../src/utils/logger.js';
import type { MCPServerConfig } from '../../src/mcp/mcp-client.js';
import type { UpstreamMcpClientManager } from '../../src/mcp/upstream-mcp-client-manager.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/file-watcher.js', () => {
  return {
    FileWatcher: vi.fn(),
  };
});

vi.mock('../../src/mcp/config.js', () => {
  return {
    loadMCPConfigFile: vi.fn(),
    getServerConfig: vi.fn(),
  };
});

vi.mock('../../src/utils/logger.js', () => {
  return {
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const MockFileWatcher = vi.mocked(FileWatcher);
const mockLoadMCPConfigFile = vi.mocked(loadMCPConfigFile);
const mockGetServerConfig = vi.mocked(getServerConfig);
const mockLogDebug = vi.mocked(logDebug);
const mockLogInfo = vi.mocked(logInfo);
const mockLogWarn = vi.mocked(logWarn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * FileWatcher mock that captures the change callback so tests can trigger it
 * manually.  The instance exposes a `start` spy and a `close` spy.
 */
interface MockFileWatcherInstance {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let capturedFileChangeCallback: ((filePath: string) => void) | null = null;
let fileWatcherInstance: MockFileWatcherInstance;

function setupFileWatcherMock(): void {
  fileWatcherInstance = {
    start: vi.fn(),
    close: vi.fn(),
  };

  // Use mockImplementation with a regular function (not arrow) so `new FileWatcher(…)`
  // works correctly — vitest requires the mock to be constructable.
  MockFileWatcher.mockImplementation(function (
    this: MockFileWatcherInstance,
    _path: string,
    callback: (filePath: string) => void | Promise<void>,
  ) {
    capturedFileChangeCallback = callback as (filePath: string) => void;
    Object.assign(this, fileWatcherInstance);
  } as unknown as typeof FileWatcher);
}

/** Build a minimal MCPJsonConfig fixture */
function makeConfig(
  servers: Record<string, object> = {}
): MCPJsonConfig {
  return { servers } as MCPJsonConfig;
}

/** Build a minimal MCPServerConfig fixture */
function makeServerConfig(name: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name,
    type: 'stdio',
    command: `cmd-${name}`,
    args: [],
    ...overrides,
  };
}

/** Create a mock ServerManager with jest-spy methods */
function makeServerManager(): UpstreamMcpClientManager {
  return {
    connectServer: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    disconnectServer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as UpstreamMcpClientManager;
}

/**
 * Flush pending promises / microtasks.
 * Use multiple `await Promise.resolve()` cycles to drain nested async chains.
 */
async function flushPromises(): Promise<void> {
  // Multiple rounds to allow chained awaits in handleConfigChange to settle
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Helper: trigger the captured file-change callback and flush promises */
async function triggerFileChange(): Promise<void> {
  if (!capturedFileChangeCallback) {
    throw new Error('FileWatcher callback was not captured — did you call start()?');
  }
  capturedFileChangeCallback('/workspace/mcp.json');
  await flushPromises();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ConfigWatcher', () => {
  let serverManager: UpstreamMcpClientManager;
  let onServersChanged: ReturnType<typeof vi.fn<() => Promise<void>>>;

  const CONFIG_PATH = '/workspace/mcp.json';

  const initialServerAEntry = { type: 'stdio', command: 'cmd-a', args: [] };
  const initialServerBEntry = { type: 'http', url: 'http://example.com' };

  const initialConfig = makeConfig({
    'server-a': initialServerAEntry,
    'server-b': initialServerBEntry,
  });

  function makeWatcher(overrides: Partial<ConfigWatcherOptions> = {}): ConfigWatcher {
    const options: ConfigWatcherOptions = {
      configPath: CONFIG_PATH,
      serverManager,
      onServersChanged,
      ...overrides,
    };
    return new ConfigWatcher(options);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedFileChangeCallback = null;
    serverManager = makeServerManager();
    onServersChanged = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setupFileWatcherMock();

    // Default: getServerConfig returns a sensible MCPServerConfig for any name
    mockGetServerConfig.mockImplementation((_config: MCPJsonConfig, name: string) =>
      makeServerConfig(name)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('should create a FileWatcher for the given configPath', () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      expect(MockFileWatcher).toHaveBeenCalledOnce();
      expect(MockFileWatcher).toHaveBeenCalledWith(CONFIG_PATH, expect.any(Function));
    });

    it('should call start() on the underlying FileWatcher', () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      expect(fileWatcherInstance.start).toHaveBeenCalledOnce();
    });

    it('should snapshot the initial config so diffs work on the first reload', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // Reload with the SAME config → no changes expected
      mockLoadMCPConfigFile.mockReturnValue(initialConfig);

      await triggerFileChange();

      expect(serverManager.connectServer).not.toHaveBeenCalled();
      expect(serverManager.disconnectServer).not.toHaveBeenCalled();
      expect(onServersChanged).not.toHaveBeenCalled();
    });

    it('should log an info message indicating which file is being watched', () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.stringContaining(CONFIG_PATH),
        expect.anything()
      );
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('should close the underlying FileWatcher', () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);
      watcher.stop();

      expect(fileWatcherInstance.close).toHaveBeenCalledOnce();
    });

    it('should be a no-op if start() was never called', () => {
      // Should not throw when watcher is null
      const watcher = makeWatcher();
      expect(() => watcher.stop()).not.toThrow();
    });

    it('should be safe to call stop() multiple times', () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);
      watcher.stop();
      // Second call should not throw even though watcher is now null
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Config diffing — server added
  // -------------------------------------------------------------------------

  describe('server added', () => {
    it('should call connectServer for the newly added server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.connectServer).toHaveBeenCalledWith(
        'server-c',
        expect.objectContaining({ name: 'server-c' })
      );
    });

    it('should NOT call disconnectServer for any server when only adding a new one', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.disconnectServer).not.toHaveBeenCalled();
    });

    it('should invoke onServersChanged after adding a server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(onServersChanged).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Config diffing — server removed
  // -------------------------------------------------------------------------

  describe('server removed', () => {
    it('should call disconnectServer for the removed server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        // server-b is gone
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-b');
    });

    it('should NOT call connectServer for any server when only removing one', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        // server-b is gone
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.connectServer).not.toHaveBeenCalled();
    });

    it('should invoke onServersChanged after removing a server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(onServersChanged).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Config diffing — server changed
  // -------------------------------------------------------------------------

  describe('server changed', () => {
    it('should call disconnectServer then connectServer for the changed server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-NEW', args: ['--verbose'] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      const callOrder: string[] = [];
      vi.mocked(serverManager.disconnectServer).mockImplementation(
        async (name: string) => { callOrder.push(`disconnect:${name}`); }
      );
      vi.mocked(serverManager.connectServer).mockImplementation(
        async (name: string) => { callOrder.push(`connect:${name}`); return true; }
      );

      await triggerFileChange();

      expect(callOrder).toContain('disconnect:server-a');
      expect(callOrder).toContain('connect:server-a');
      // disconnect must appear before connect for the same server
      expect(callOrder.indexOf('disconnect:server-a')).toBeLessThan(
        callOrder.indexOf('connect:server-a')
      );
    });

    it('should invoke onServersChanged after changing a server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-UPDATED', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(onServersChanged).toHaveBeenCalledOnce();
    });

    it('should pass the new config to getServerConfig when reconnecting a changed server', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-v2', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(mockGetServerConfig).toHaveBeenCalledWith(newConfig, 'server-a');
    });
  });

  // -------------------------------------------------------------------------
  // Config diffing — no changes
  // -------------------------------------------------------------------------

  describe('no changes detected', () => {
    it('should NOT call connectServer or disconnectServer when config is identical', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // Reload with the exact same data
      mockLoadMCPConfigFile.mockReturnValue(makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
      }));

      await triggerFileChange();

      expect(serverManager.connectServer).not.toHaveBeenCalled();
      expect(serverManager.disconnectServer).not.toHaveBeenCalled();
    });

    it('should NOT invoke onServersChanged when config is identical', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      mockLoadMCPConfigFile.mockReturnValue(makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
      }));

      await triggerFileChange();

      expect(onServersChanged).not.toHaveBeenCalled();
    });

    it('should log a debug message when entries are unchanged', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      mockLoadMCPConfigFile.mockReturnValue(makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
      }));

      await triggerFileChange();

      expect(mockLogDebug).toHaveBeenCalledWith(
        expect.stringContaining('unchanged'),
        expect.anything()
      );
    });
  });

  // -------------------------------------------------------------------------
  // serverFilter
  // -------------------------------------------------------------------------

  describe('serverFilter', () => {
    it('should only manage servers that appear in the filter list', async () => {
      const watcher = makeWatcher({ serverFilter: ['server-a'] });
      // Initial config has both server-a and server-b, but the watcher only
      // tracks server-a.  Start with only server-a in scope.
      watcher.start(initialConfig);

      // New config: server-b changes (not in filter), server-a also changes
      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-updated', args: [] },
        'server-b': { type: 'http', url: 'http://changed.example.com' },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      // Only server-a should have triggered a reconnect
      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-a');
      expect(serverManager.connectServer).toHaveBeenCalledWith('server-a', expect.anything());
      // server-b must NOT have been touched
      expect(serverManager.disconnectServer).not.toHaveBeenCalledWith('server-b');
      expect(serverManager.connectServer).not.toHaveBeenCalledWith('server-b', expect.anything());
    });

    it('should ignore a newly-added server that is NOT in the filter', async () => {
      const watcher = makeWatcher({ serverFilter: ['server-a', 'server-b'] });
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] }, // not in filter
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.connectServer).not.toHaveBeenCalled();
      expect(serverManager.disconnectServer).not.toHaveBeenCalled();
      expect(onServersChanged).not.toHaveBeenCalled();
    });

    it('should track a server that IS in the filter and has been added', async () => {
      // Watcher monitors server-a, server-b, and server-c — but initial config
      // only has server-a and server-b.  A reload that adds server-c should connect it.
      const watcher = makeWatcher({ serverFilter: ['server-a', 'server-b', 'server-c'] });
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(serverManager.connectServer).toHaveBeenCalledWith('server-c', expect.anything());
    });
  });

  // -------------------------------------------------------------------------
  // Invalid JSON on reload
  // -------------------------------------------------------------------------

  describe('invalid JSON on reload', () => {
    it('should log a warning when loadMCPConfigFile throws', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      mockLoadMCPConfigFile.mockImplementation(() => {
        throw new Error('Unexpected token < in JSON at position 0');
      });

      await triggerFileChange();

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected token'),
        expect.anything()
      );
    });

    it('should NOT call connectServer or disconnectServer when config parse fails', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      mockLoadMCPConfigFile.mockImplementation(() => {
        throw new Error('SyntaxError: invalid JSON');
      });

      await triggerFileChange();

      expect(serverManager.connectServer).not.toHaveBeenCalled();
      expect(serverManager.disconnectServer).not.toHaveBeenCalled();
    });

    it('should NOT invoke onServersChanged when config parse fails', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      mockLoadMCPConfigFile.mockImplementation(() => {
        throw new SyntaxError('Unexpected end of JSON input');
      });

      await triggerFileChange();

      expect(onServersChanged).not.toHaveBeenCalled();
    });

    it('should preserve the existing lastKnownEntries so subsequent valid reloads diff correctly', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // First reload: bad JSON
      mockLoadMCPConfigFile.mockImplementationOnce(() => {
        throw new Error('bad JSON');
      });
      await triggerFileChange();

      // Second reload: valid config with one changed server
      const updatedConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-v2', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValueOnce(updatedConfig);
      await triggerFileChange();

      // The second reload should still detect the change against the original snapshot
      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-a');
      expect(serverManager.connectServer).toHaveBeenCalledWith('server-a', expect.anything());
    });
  });

  // -------------------------------------------------------------------------
  // Reload guard
  // -------------------------------------------------------------------------

  describe('reload guard', () => {
    it('should skip a second change event while the first reload is in progress', async () => {
      // Make disconnectServer block until we manually resolve it
      let releaseFirstReload!: () => void;
      const blockPromise = new Promise<void>((resolve) => {
        releaseFirstReload = resolve;
      });

      vi.mocked(serverManager.disconnectServer).mockImplementationOnce(async () => {
        await blockPromise;
      });

      // First config reload removes server-a
      const configWithoutA = makeConfig({
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(configWithoutA);

      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // Trigger first reload — will block at disconnectServer
      capturedFileChangeCallback!('/workspace/mcp.json');
      // Allow the async chain to start and block
      await flushPromises();

      // While first reload is blocked, trigger a second event
      capturedFileChangeCallback!('/workspace/mcp.json');
      await flushPromises();

      // The guard should have logged a debug message for the skipped second event
      expect(mockLogDebug).toHaveBeenCalledWith(
        expect.stringContaining('already in progress'),
        expect.anything()
      );

      // Unblock the first reload
      releaseFirstReload();
      await flushPromises();
    });

    it('should allow a new reload after the previous one completes', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // First reload — adds server-c
      const configWithC = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValueOnce(configWithC);
      await triggerFileChange();

      expect(serverManager.connectServer).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      // Restore mocks that were cleared
      vi.mocked(serverManager.disconnectServer).mockResolvedValue(undefined);
      vi.mocked(serverManager.connectServer).mockResolvedValue(true);
      onServersChanged.mockResolvedValue(undefined);
      mockGetServerConfig.mockImplementation((_config: MCPJsonConfig, name: string) =>
        makeServerConfig(name)
      );

      // Second reload — removes server-c again (goes back to initial)
      mockLoadMCPConfigFile.mockReturnValueOnce(initialConfig);
      await triggerFileChange();

      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-c');
    });
  });

  // -------------------------------------------------------------------------
  // Per-server connection error
  // -------------------------------------------------------------------------

  describe('per-server connection error', () => {
    it('should still connect other servers when one connectServer call fails', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // New config adds two servers: server-c (will fail) and server-d (should succeed)
      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
        'server-d': { type: 'stdio', command: 'cmd-d', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      vi.mocked(serverManager.connectServer).mockImplementation(
        async (name: string) => {
          if (name === 'server-c') throw new Error('Connection refused');
          return true;
        }
      );

      await triggerFileChange();

      // server-d should still have been attempted
      expect(serverManager.connectServer).toHaveBeenCalledWith('server-d', expect.anything());
    });

    it('should log a warning for the failed server connection', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      vi.mocked(serverManager.connectServer).mockRejectedValue(
        new Error('ECONNREFUSED')
      );

      await triggerFileChange();

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
        expect.anything()
      );
    });

    it('should still invoke onServersChanged even when a server fails to connect', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': initialServerAEntry,
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      vi.mocked(serverManager.connectServer).mockRejectedValue(
        new Error('Timeout')
      );

      await triggerFileChange();

      expect(onServersChanged).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // onServersChanged callback ordering
  // -------------------------------------------------------------------------

  describe('onServersChanged callback', () => {
    it('should be called AFTER all disconnect and connect operations complete', async () => {
      const callOrder: string[] = [];

      vi.mocked(serverManager.disconnectServer).mockImplementation(
        async (name: string) => { callOrder.push(`disconnect:${name}`); }
      );
      vi.mocked(serverManager.connectServer).mockImplementation(
        async (name: string) => { callOrder.push(`connect:${name}`); return true; }
      );
      onServersChanged.mockImplementation(async () => {
        callOrder.push('onServersChanged');
      });

      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // Trigger a change: server-a gets updated (disconnect + connect), server-c added (connect only)
      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-v2', args: [] },
        'server-b': initialServerBEntry,
        'server-c': { type: 'stdio', command: 'cmd-c', args: [] },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      const onServersChangedIndex = callOrder.indexOf('onServersChanged');
      expect(onServersChangedIndex).toBeGreaterThan(-1);

      // All disconnect/connect operations must have been recorded before the callback
      const connectDisconnectOps = callOrder.filter((e) => e !== 'onServersChanged');
      connectDisconnectOps.forEach((op) => {
        expect(callOrder.indexOf(op)).toBeLessThan(onServersChangedIndex);
      });
    });

    it('should be called exactly once per change event that has actual diffs', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-v2', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      expect(onServersChanged).toHaveBeenCalledTimes(1);
    });

    it('should update lastKnownEntries after a successful reload so the next diff is correct', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      // First reload: change server-a
      const configV2 = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-v2', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValueOnce(configV2);
      await triggerFileChange();

      vi.clearAllMocks();
      // Restore mocks cleared above
      vi.mocked(serverManager.disconnectServer).mockResolvedValue(undefined);
      vi.mocked(serverManager.connectServer).mockResolvedValue(true);
      onServersChanged.mockResolvedValue(undefined);

      // Second reload: same as configV2 → no diff expected
      mockLoadMCPConfigFile.mockReturnValueOnce(configV2);
      await triggerFileChange();

      expect(onServersChanged).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Combined diff scenarios
  // -------------------------------------------------------------------------

  describe('combined diff scenarios', () => {
    it('should handle add, remove, and change in the same reload', async () => {
      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        // server-a: changed
        'server-a': { type: 'stdio', command: 'cmd-a-changed', args: [] },
        // server-b: removed (not present)
        // server-c: added
        'server-c': { type: 'http', url: 'http://new-server.example.com' },
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      // Disconnected: server-a (changed) + server-b (removed)
      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-a');
      expect(serverManager.disconnectServer).toHaveBeenCalledWith('server-b');
      // Connected: server-a (changed) + server-c (added)
      expect(serverManager.connectServer).toHaveBeenCalledWith('server-a', expect.anything());
      expect(serverManager.connectServer).toHaveBeenCalledWith('server-c', expect.anything());
      // Callback fired once
      expect(onServersChanged).toHaveBeenCalledOnce();
    });

    it('should call disconnectServer before connectServer in a combined scenario', async () => {
      const callOrder: string[] = [];

      vi.mocked(serverManager.disconnectServer).mockImplementation(
        async (name: string) => { callOrder.push(`disconnect:${name}`); }
      );
      vi.mocked(serverManager.connectServer).mockImplementation(
        async (name: string) => { callOrder.push(`connect:${name}`); return true; }
      );

      const watcher = makeWatcher();
      watcher.start(initialConfig);

      const newConfig = makeConfig({
        'server-a': { type: 'stdio', command: 'cmd-a-changed', args: [] },
        'server-b': initialServerBEntry,
      });
      mockLoadMCPConfigFile.mockReturnValue(newConfig);

      await triggerFileChange();

      // Implementation disconnects removed+changed FIRST, then connects added+changed
      const disconnectIdx = callOrder.indexOf('disconnect:server-a');
      const connectIdx = callOrder.indexOf('connect:server-a');
      expect(disconnectIdx).toBeGreaterThan(-1);
      expect(connectIdx).toBeGreaterThan(-1);
      expect(disconnectIdx).toBeLessThan(connectIdx);
    });
  });
});
