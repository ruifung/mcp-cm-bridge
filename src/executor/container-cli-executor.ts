/**
 * Container-based Executor — CLI implementation (Docker/Podman spawn).
 *
 * Runs LLM-generated code inside a Docker/Podman container using the CLI binary.
 * This is used as a fallback when direct socket communication (Dockerode) is
 * unavailable or failing (e.g., on Deno on Windows).
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RemoteExecutorBase } from './remote-executor-base.js';
import type { HostMessage } from './remote-executor-types.js';
import { logDebug, logError } from '../utils/logger.js';
import { getScriptPaths } from './script-paths.js';

const MAX_STDERR_LINES = 100;
const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds

// ── Types ───────────────────────────────────────────────────────────

export interface ContainerCliExecutorOptions {
  /** Execution timeout per call in ms (default 30000) */
  timeout?: number;
  /** Container image (default 'node:24-slim') */
  image?: string;
  /** Container user (default based on image) */
  user?: string;
  /** Container command to run the runner (default based on image) */
  command?: string[];
  /** Container runtime command — 'docker' | 'podman' | auto-detect */
  runtime?: string;
  /** Memory limit (default '512M') */
  memoryLimit?: string;
  /** CPU quota as fractional CPUs (default 1.0) */
  cpuLimit?: number;
}

// ── Runtime detection ───────────────────────────────────────────────

function detectRuntime(requested?: string): string {
  if (requested) return requested;

  // Try docker first, then podman
  for (const cmd of ['docker', 'podman']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return cmd;
    } catch {
      // not available
    }
  }

  throw new Error(
    'No container runtime found. Install Docker or Podman, ' +
    'or set CONTAINER_RUNTIME environment variable.'
  );
}

// ── ContainerCliExecutor ───────────────────────────────────────────

export class ContainerCliExecutor extends RemoteExecutorBase {
  private runtime: string;
  private image: string;
  private containerUser: string;
  private containerCommand: string[];
  private memoryLimit: string;
  private cpuLimit: number;

  private process: ChildProcess | null = null;
  private stderrLines: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: ContainerCliExecutorOptions = {}) {
    super(options.timeout ?? 30000);
    this.memoryLimit = options.memoryLimit ?? '512M';
    this.cpuLimit = options.cpuLimit ?? 1.0;
    this.runtime = detectRuntime(options.runtime);

    // Fixed Deno defaults — container always runs Deno
    this.image = options.image ?? 'denoland/deno:debian';
    this.containerUser = options.user ?? '1000';
    this.containerCommand = options.command ?? ['deno', 'run', '--allow-read', '--deny-env', '--allow-net=none'];

    logDebug(`[ContainerCliExecutor] Initialized with image: ${this.image}`, { component: 'Executor' });
  }

  /**
   * Pull the container image if not already present.
   * Runs synchronously so the image is ready before we start the container.
   */
  private async pullImage(): Promise<void> {
    // Check if image exists locally first
    try {
      execFileSync(this.runtime, ['image', 'inspect', this.image], {
        stdio: 'ignore',
        timeout: 10000,
      });
      return; // image already present
    } catch {
      // image not found locally, pull it
    }

    // Pull the image — this can take a while on first run
    return new Promise<void>((resolve, reject) => {
      const pull = spawn(this.runtime, ['pull', this.image], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      pull.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(`[container-cli] ${data.toString()}`);
      });

      pull.stdout?.on('data', (data: Buffer) => {
        process.stderr.write(`[container-cli] ${data.toString()}`);
      });

      pull.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to pull image '${this.image}' (exit code ${code})`));
        }
      });

      pull.on('error', (err) => {
        reject(new Error(`Failed to pull image '${this.image}': ${err.message}`));
      });
    });
  }

  protected async _init(): Promise<void> {
    const scripts = getScriptPaths();

    // Pull the image first (no-op if already present)
    logDebug('[Executor:CLI] Checking image...', { component: 'Executor' });
    await this.pullImage();
    logDebug('[Executor:CLI] Image ready', { component: 'Executor' });

    // Start a long-lived container with the runner + worker scripts
    const suffix = randomBytes(4).toString('hex');
    const containerName = `codemode-executor-cli-${suffix}`;
    const args = [
      'run',
      '--rm',
      '-i',                           // keep stdin open
      '--name', containerName,        // identifiable container name
      '--network=none',               // no network
      '--read-only',                   // immutable rootfs
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',  // writable /tmp
      '--cap-drop=ALL',               // drop all capabilities
      '--user', this.containerUser,
      '--memory', this.memoryLimit,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=128',              // limit process spawning
      '-v', `${scripts.runner}:/app/container-runner.ts:ro`,  // mount runner script
      '-v', `${scripts.worker}:/app/container-worker.ts:ro`,  // mount worker script
      '-w', '/app',
      '--label', `codemode.host-pid=${process.pid}`,
      '--label', `codemode.created-at=${new Date().toISOString()}`,
      this.image,
      ...this.containerCommand, '/app/container-runner.ts', '--no-heartbeat', '--worker-path=/app/container-worker.ts',
    ];

    logDebug('[Executor:CLI] Creating container...', { component: 'Executor' });
    this.process = spawn(this.runtime, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logDebug('[Executor:CLI] Container process spawned', { component: 'Executor' });

    // Forward stderr for debugging and buffer for diagnostics
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[container-cli] ${text}`);
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          this.stderrLines.push(trimmed);
          if (this.stderrLines.length > MAX_STDERR_LINES) {
            this.stderrLines.shift();
          }
        }
      }
    });

    this.process.on('exit', (code) => {
      logDebug(`[Executor:CLI] Container process exited with code ${code}`, { component: 'Executor' });
      this.ready = false;
      // Reject any pending execution
      if (this.pendingExecution) {
        const stderrSummary = this.stderrLines.length
          ? `\nStderr:\n${this.stderrLines.join('\n')}`
          : '';
        clearTimeout(this.pendingExecution.timeoutHandle);
        this.pendingExecution.reject(
          new Error(`Container exited unexpectedly with code ${code}.${stderrSummary}`)
        );
        this.pendingExecution = null;
      }
    });

    // Set up line reader on stdout
    this.readline = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.readline.on('line', (line) => {
      logDebug(`[Executor:CLI] Container stdout: ${line.substring(0, 200)}`, { component: 'Executor' });
      this.handleMessage(line);
    });

    // Wait for the "ready" message (generous timeout to allow image pull)
    logDebug('[Executor:CLI] Waiting for ready signal...', { component: 'Executor' });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Container failed to become ready within 120s'));
      }, 120000);

      const cleanup = (err?: Error) => {
        clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
        // Remove the close listener so it doesn't fire again after we're done
        this.process?.removeListener('close', onClose);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      // Store resolve so handleMessage can call it when ready arrives
      this.readyResolve = () => {
        this.ready = true;
        cleanup();
      };

      this.readyReject = (err: Error) => {
        cleanup(err);
      };

      // Detect premature exit before the ready signal arrives
      const onClose = (code: number | null) => {
        const stderrSummary = this.stderrLines.length
          ? `\nStderr:\n${this.stderrLines.join('\n')}`
          : '';
        cleanup(new Error(`Container exited prematurely with code ${code}.${stderrSummary}`));
      };
      this.process!.once('close', onClose);

      // Handle spawn failure
      this.process!.on('error', (err) => {
        cleanup(new Error(`Failed to start container: ${err.message}`));
      });
    });

    // Start heartbeat — periodically send a ping so the container can detect host crashes
    this.heartbeatInterval = setInterval(() => {
      try {
        this.send({ type: 'heartbeat' });
      } catch {
        // stream broken — will be caught by exit watcher
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  protected send(msg: HostMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Container stdin is not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  protected onBadJson(line: string): void {
    logError('Container sent non-JSON output (likely crashed)', { output: line });
    if (this.readyReject) {
      this.readyReject(new Error('Container sent non-JSON output: ' + line));
    } else if (this.pendingExecution) {
      clearTimeout(this.pendingExecution.timeoutHandle);
      this.pendingExecution.reject(new Error('Container sent non-JSON output: ' + line));
      this.pendingExecution = null;
    }
  }

  protected onFatalError(error: { message: string; stack?: string; name?: string }): void {
    logError(
      `[Executor:CLI] Container runner fatal error: ${error.message}\n${error.stack ?? ''}`,
      { component: 'Executor' }
    );
    super.onFatalError(error);
  }

  protected onDisposePrepare(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  protected onDisposeKill(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 5 seconds if still alive
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
      this.process = null;
    }
  }
}

/**
 * Factory function matching the pattern of other executors.
 */
export function createContainerCliExecutor(options?: ContainerCliExecutorOptions): ContainerCliExecutor {
  return new ContainerCliExecutor(options);
}
