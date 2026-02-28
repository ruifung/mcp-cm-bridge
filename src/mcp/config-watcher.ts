/**
 * ConfigWatcher - watches mcp.json for changes and hot-reloads upstream server
 * connections via ServerManager.
 *
 * When a change is detected the watcher diffs the old vs. new server list and:
 *   • connects newly-added servers
 *   • disconnects removed servers
 *   • reconnects servers whose config changed
 *
 * After the server set stabilises it invokes the provided onServersChanged()
 * callback so the caller can rebuild the eval tool in-place.
 */

import { FileWatcher } from "../utils/file-watcher.js";
import { UpstreamMcpClientManager } from "./upstream-mcp-client-manager.js";
import type { MCPServerConfig } from "./mcp-client.js";
import { loadMCPConfigFile, getServerConfig, type MCPJsonConfig } from "./config.js";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";

const COMPONENT = 'ConfigWatcher';

export interface ConfigWatcherOptions {
  /** Absolute path to the mcp.json file being watched. */
  configPath: string;
  /**
   * Optional filter: only manage servers whose names appear in this list.
   * When undefined every server in the config file is managed.
   */
  serverFilter?: string[];
  serverManager: UpstreamMcpClientManager;
  /** Called after the server set has changed so the eval tool can be rebuilt. */
  onServersChanged: () => Promise<void>;
}

export class ConfigWatcher {
  private readonly configPath: string;
  private readonly serverFilter: string[] | undefined;
  private readonly serverManager: UpstreamMcpClientManager;
  private readonly onServersChanged: () => Promise<void>;

  private watcher: FileWatcher | null = null;
  /** Serialised representation of the server entries from the last-known config. */
  private lastKnownEntries: Record<string, string> = {};
  /** Reload guard — prevents concurrent reloads. */
  private reloading = false;

  constructor(options: ConfigWatcherOptions) {
    this.configPath = options.configPath;
    this.serverFilter = options.serverFilter;
    this.serverManager = options.serverManager;
    this.onServersChanged = options.onServersChanged;
  }

  /**
   * Start watching the config file.  The initial server entries are snapshotted
   * here so subsequent diffs work correctly.
   */
  start(initialConfig: MCPJsonConfig): void {
    // Snapshot the initial state.
    this.lastKnownEntries = this.serialiseEntries(initialConfig);

    this.watcher = new FileWatcher(this.configPath, () => {
      void this.handleConfigChange();
    });
    this.watcher.start();

    logInfo(`Watching config file for changes: ${this.configPath}`, { component: COMPONENT });
  }

  /**
   * Stop watching the config file.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async handleConfigChange(): Promise<void> {
    if (this.reloading) {
      logDebug('Config reload already in progress, skipping', { component: COMPONENT });
      return;
    }
    this.reloading = true;

    try {
      logInfo('Config file changed — loading new config…', { component: COMPONENT });

      let newConfig: MCPJsonConfig;
      try {
        newConfig = loadMCPConfigFile(this.configPath);
      } catch (error) {
        logWarn(
          `Failed to parse updated config, keeping current servers: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { component: COMPONENT }
        );
        return;
      }

      const newEntries = this.serialiseEntries(newConfig);
      const diff = this.diffEntries(this.lastKnownEntries, newEntries);

      const hasChanges =
        diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

      if (!hasChanges) {
        logDebug('Config file touched but server entries unchanged — skipping reload', {
          component: COMPONENT,
        });
        return;
      }

      logInfo(
        `Config diff — added: [${diff.added.join(', ')}]  removed: [${diff.removed.join(', ')}]  changed: [${diff.changed.join(', ')}]`,
        { component: COMPONENT }
      );

      // Disconnect removed + changed servers first.
      const toDisconnect = [...diff.removed, ...diff.changed];
      await Promise.all(toDisconnect.map((name) => this.serverManager.disconnectServer(name)));

      // Connect added + changed servers.
      const toConnect = [...diff.added, ...diff.changed];
      await Promise.all(
        toConnect.map(async (name) => {
          try {
            const cfg = getServerConfig(newConfig, name);
            await this.serverManager.connectServer(name, cfg);
          } catch (error) {
            logWarn(
              `Could not connect to "${name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
              { component: COMPONENT }
            );
          }
        })
      );

      // Commit the new snapshot only after a successful reload.
      this.lastKnownEntries = newEntries;

      // Notify caller to rebuild the eval tool.
      await this.onServersChanged();
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Build a map of serverName → JSON-stringified config entry for every server
   * that is in scope (respects serverFilter).
   */
  private serialiseEntries(config: MCPJsonConfig): Record<string, string> {
    const result: Record<string, string> = {};
    const servers = config.servers ?? {};

    for (const [name, entry] of Object.entries(servers)) {
      if (this.serverFilter && !this.serverFilter.includes(name)) {
        continue;
      }
      result[name] = JSON.stringify(entry);
    }

    return result;
  }

  /**
   * Compare two serialised-entry snapshots and return the sets of names that
   * were added, removed, or changed.
   */
  private diffEntries(
    oldEntries: Record<string, string>,
    newEntries: Record<string, string>
  ): { added: string[]; removed: string[]; changed: string[] } {
    const oldNames = new Set(Object.keys(oldEntries));
    const newNames = new Set(Object.keys(newEntries));

    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));
    const changed = [...newNames].filter(
      (n) => oldNames.has(n) && oldEntries[n] !== newEntries[n]
    );

    return { added, removed, changed };
  }
}
