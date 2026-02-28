/**
 * Container-based Executor — direct socket communication via Dockerode.
 * 
 * Talks directly to the Docker/Podman socket (Unix socket or Named Pipe)
 * instead of spawning CLI processes.
 */

import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { RemoteExecutorBase } from './remote-executor-base.js';
import type { HostMessage } from './remote-executor-types.js';
import { resolveDockerSocketPath } from '../utils/docker.js';
import { logDebug, logInfo, logError } from '../utils/logger.js';
import { getScriptPaths } from './script-paths.js';

const MAX_STDERR_LINES = 100;
const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds

// ── Types ───────────────────────────────────────────────────────────

export interface ContainerSocketExecutorOptions {
  /** Execution timeout per call in ms (default 30000) */
  timeout?: number;
  /** Container image (default 'node:24-slim') */
  image?: string;
  /** Container user (default based on image) */
  user?: string;
  /** Container command to run the runner (default based on image) */
  command?: string[];
  /** Docker socket path (default detected based on platform) */
  socketPath?: string;
  /** Memory limit (default 512MB, can be number of bytes or string like '512M') */
  memoryLimit?: number | string;
  /** CPU quota as fractional CPUs (default 1.0) */
  cpuLimit?: number;
}

// ── ContainerSocketExecutor ─────────────────────────────────────────
 
export class ContainerSocketExecutor extends RemoteExecutorBase {

  private docker: Docker;
  private image: string;
  private containerUser: string;
  private containerCommand: string[];
  private memoryLimit: number;
  private cpuLimit: number;

  private container: Docker.Container | null = null;
  private execStream: any = null;
  private stderrLines: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: ContainerSocketExecutorOptions = {}) {
    super(options.timeout ?? 30000);
    
    // Parse memory limit
    if (typeof options.memoryLimit === 'string') {
      const match = options.memoryLimit.match(/^(\d+)([KMG]?)$/i);
      if (match) {
        let val = parseInt(match[1], 10);
        const unit = match[2].toUpperCase();
        if (unit === 'K') val *= 1024;
        else if (unit === 'M') val *= 1024 * 1024;
        else if (unit === 'G') val *= 1024 * 1024 * 1024;
        this.memoryLimit = val;
      } else {
        this.memoryLimit = 512 * 1024 * 1024;
      }
    } else {
      this.memoryLimit = options.memoryLimit ?? 512 * 1024 * 1024;
    }
    
    this.cpuLimit = options.cpuLimit ?? 1.0;

    const socketPath = options.socketPath ?? resolveDockerSocketPath();
    this.docker = new Docker(socketPath ? { socketPath } : {});

    // Fixed Deno defaults — container always runs Deno
    this.image = options.image ?? 'denoland/deno:debian';
    this.containerUser = options.user ?? '1000';
    this.containerCommand = options.command ?? ['deno', 'run', '--allow-read', '--deny-env', '--allow-net=none'];

    logDebug(`[ContainerExecutor] Initialized with image: ${this.image}`, { component: 'Executor' });
  }

  private async pullImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch {
      // Not present
    }

    logInfo(`Pulling image ${this.image}...`, { component: 'Executor' });
    const stream = await this.docker.pull(this.image);
    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
    });
    logDebug(`Pull complete for ${this.image}`, { component: 'Executor' });
  }

  /**
   * Applies a proxy to the dockerode modem to avoid stdin pollution during attach.
   * Workaround for: https://github.com/apocas/dockerode/issues/742#issuecomment-2118211139
   */
  private _proxyModem(): void {
    if (!this.docker.modem || (this.docker.modem as any)._isProxied) return;

    this.docker.modem = new Proxy(this.docker.modem, {
      get(target, prop) {
        const origMethod = (target as any)[prop];
        if (prop === 'dial') {
          return function (options: any, callback: any) {
            if (options.path.endsWith('/attach?')) {
              options.file = Buffer.from('');
            }
            return origMethod.apply(target, [options, callback]);
          };
        }
        if (prop === '_isProxied') return true;
        return origMethod;
      },
    });
  }

  protected async _init(): Promise<void> {
    const scripts = getScriptPaths();
    logDebug('[Executor:Socket] Checking image...', { component: 'Executor' });
    await this.pullImage();
    logDebug('[Executor:Socket] Image ready', { component: 'Executor' });

    const suffix = randomBytes(4).toString('hex');
    const containerName = `codemode-executor-container-${suffix}`;

    // Apply the proxy fix to avoid stdin pollution during attach
    this._proxyModem();

    try {
      logDebug('[Executor:Socket] Creating container...', { component: 'Executor' });
      // Create the container with the runner as the primary process
      this.container = await this.docker.createContainer({
        name: containerName,
        Image: this.image,
        Cmd: [...this.containerCommand, '/app/container-runner.ts', '--no-heartbeat', '--worker-path=/app/container-worker.ts'],
        Env: [],
        User: this.containerUser,
        OpenStdin: true,
        Labels: {
          'codemode.host-pid': String(process.pid),
          'codemode.created-at': new Date().toISOString(),
        },
        HostConfig: {
          AutoRemove: true,
          NetworkMode: 'none',
          Memory: this.memoryLimit,
          CpuQuota: this.cpuLimit * 100000, // Docker uses quota/period (default period 100k)
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
          CapDrop: ['ALL'],
          Binds: [
            `${scripts.runner}:/app/container-runner.ts:ro`,
            `${scripts.worker}:/app/container-worker.ts:ro`
          ],
          PidsLimit: 128
        },
        WorkingDir: '/app'
      });
      logDebug('[Executor:Socket] Container created', { component: 'Executor' });

      // Attach BEFORE starting to capture the first messages
      logDebug('[Executor:Socket] Attaching stream...', { component: 'Executor' });
      const attachPromise = this.container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true
      });
      const attachTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Container attach timed out after 10s')), 10000)
      );
      this.execStream = await Promise.race([attachPromise, attachTimeoutPromise]);
      logDebug('[Executor:Socket] Stream attached', { component: 'Executor' });

      logDebug('[Executor:Socket] Starting container...', { component: 'Executor' });
      await this.container.start();
      logDebug('[Executor:Socket] Container started', { component: 'Executor' });
    } catch (err) {
      logError(`Failed to create or start container: ${err instanceof Error ? err.message : String(err)}`, { component: 'Executor' });
      throw err;
    }

    logDebug(`Container executor started: ${this.container.id}`, { component: 'Executor' });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(this.execStream, stdout, stderr);

    stderr.on('data', (chunk) => {
      const text = chunk.toString();
      process.stderr.write(`[container-executor] ${text}`);
      // Buffer stderr lines for diagnostics (e.g. premature exit error messages)
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

    this.readline = createInterface({
      input: stdout,
      terminal: false
    });

    this.readline.on('line', (line) => {
      logDebug(`[Executor:Socket] Container stdout: ${line.substring(0, 200)}`, { component: 'Executor' });
      this.handleMessage(line);
    });

    logDebug('[Executor:Socket] Waiting for ready signal...', { component: 'Executor' });
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Container failed to become ready within 120s'));
      }, 120000);

      this.readyResolve = () => {
        clearTimeout(timeout);
        this.ready = true;
        this.readyResolve = null;
        this.readyReject = null;
        resolve();
      };

      this.readyReject = (err: Error) => {
        clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
        reject(err);
      };
    });

    // Race ready signal against container exiting prematurely
    const exitPromise = this.container!.wait().then((result: { StatusCode: number }) => {
      const exitCode = result.StatusCode;
      const stderrSummary = this.stderrLines.length
        ? `\nStderr:\n${this.stderrLines.join('\n')}`
        : '';
      throw new Error(`Container exited prematurely with code ${exitCode}.${stderrSummary}`);
    });

    await Promise.race([readyPromise, exitPromise]);

    // After init succeeds, keep watching for unexpected container exits during execution.
    // We re-use container.wait() — it still resolves because the container is still running at
    // this point and Dockerode allows multiple waiters.
    this.container!.wait().then((result: { StatusCode: number }) => {
      this.ready = false;
      if (this.pendingExecution) {
        const exitCode = result.StatusCode;
        const stderrSummary = this.stderrLines.length
          ? `\nStderr:\n${this.stderrLines.join('\n')}`
          : '';
        clearTimeout(this.pendingExecution.timeoutHandle);
        this.pendingExecution.reject(
          new Error(`Container exited unexpectedly with code ${exitCode}.${stderrSummary}`)
        );
        this.pendingExecution = null;
      }
    }).catch(() => { /* container already gone / disposed — ignore */ });

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
    if (this.execStream) {
      this.execStream.write(JSON.stringify(msg) + '\n');
    }
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
      `[Executor:Socket] Container runner fatal error: ${error.message}\n${error.stack ?? ''}`,
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

  protected onDisposeCleanup(): void {
    if (this.execStream) {
      if (typeof this.execStream.end === 'function') this.execStream.end();
      this.execStream = null;
    }
  }

  protected onDisposeKill(): void {
    if (this.container) {
      this.container.stop().catch(() => { /* ignore */ });
      this.container = null;
    }
  }
}

export function createContainerSocketExecutor(options?: ContainerSocketExecutorOptions): ContainerSocketExecutor {
  return new ContainerSocketExecutor(options);
}
