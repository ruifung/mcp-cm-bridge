/**
 * Container-based Executor — maximum isolation.
 *
 * Runs LLM-generated code inside a Docker/Podman container with:
 *   --network=none   (no network access)
 *   --read-only      (immutable root filesystem, /tmp is writable)
 *   --cap-drop=ALL   (no Linux capabilities)
 *
 * Communication uses a line-delimited JSON protocol over the container's
 * stdin/stdout.  Tool calls are proxied: the runner script inside the
 * container sends tool-call requests, the host dispatches them to the
 * real tool functions, and writes results back.
 *
 * The container is session-scoped — created once and reused across
 * execute() calls.  State is cleaned up between calls by the runner.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Executor, ExecuteResult } from '@cloudflare/codemode';
import { wrapCode } from './wrap-code.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ContainerExecutorOptions {
  /** Execution timeout per call in ms (default 30000) */
  timeout?: number;
  /** Container image (default 'node:22-slim') */
  image?: string;
  /** Container runtime command — 'docker' | 'podman' | auto-detect */
  runtime?: string;
  /** Memory limit (default '256m') */
  memoryLimit?: string;
  /** CPU quota as fractional CPUs (default 1.0) */
  cpuLimit?: number;
}

/** Messages sent from host → container */
type HostMessage =
  | { type: 'execute'; id: string; code: string }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'tool-error'; id: string; error: string }
  | { type: 'shutdown' };

/** Messages sent from container → host */
type ContainerMessage =
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'result'; id: string; result: unknown; logs?: string[] }
  | { type: 'error'; id: string; error: string; logs?: string[] }
  | { type: 'ready' };

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

// ── Resolve runner script path ──────────────────────────────────────

function getScriptPaths(): { runner: string; worker: string } {
  // Works in both ESM and CJS contexts
  let dir: string;
  try {
    // ESM
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback
    dir = __dirname;
  }
  return {
    runner: join(dir, 'container-runner.mjs'),
    worker: join(dir, 'container-worker.mjs'),
  };
}

// ── ContainerExecutor ───────────────────────────────────────────────

export class ContainerExecutor implements Executor {
  private runtime: string;
  private image: string;
  private timeout: number;
  private memoryLimit: string;
  private cpuLimit: number;

  private containerId: string | null = null;
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private ready = false;

  /** Resolved when the container sends { type: 'ready' } */
  private readyResolve: (() => void) | null = null;

  /** Pending execution — only one at a time */
  private pendingExecution: {
    id: string;
    resolve: (result: ExecuteResult) => void;
    reject: (error: Error) => void;
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
    timeoutHandle: NodeJS.Timeout;
  } | null = null;

  private initPromise: Promise<void> | null = null;

  constructor(options: ContainerExecutorOptions = {}) {
    this.timeout = options.timeout ?? 30000;
    this.image = options.image ?? 'node:24-slim';
    this.memoryLimit = options.memoryLimit ?? '256m';
    this.cpuLimit = options.cpuLimit ?? 1.0;
    this.runtime = detectRuntime(options.runtime);

    // Start initialization immediately to create the container before the first execution.
    // Errors are caught and logged, but will also be thrown when execute() awaits this.init().
    this.init().catch(err => {
      process.stderr.write(`[container-executor] Immediate initialization failed: ${err.message}\n`);
    });
  }

  /**
   * Start the container and wait for the runner to signal readiness.
   * Called lazily on first execute().
   */
  private async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
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
        process.stderr.write(`[container] ${data.toString()}`);
      });

      pull.stdout?.on('data', (data: Buffer) => {
        process.stderr.write(`[container] ${data.toString()}`);
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

  private async _init(): Promise<void> {
    const scripts = getScriptPaths();

    // Pull the image first (no-op if already present)
    await this.pullImage();

    // Start a long-lived container with the runner + worker scripts
    const suffix = randomBytes(4).toString('hex');
    const containerName = `codemode-executor-${suffix}`;
    const args = [
      'run',
      '--rm',
      '-i',                           // keep stdin open
      '--name', containerName,        // identifiable container name
      '--network=none',               // no network
      '--read-only',                   // immutable rootfs
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',  // writable /tmp
      '--cap-drop=ALL',               // drop all capabilities
      '--user', 'node',               // run as non-root user
      '--memory', this.memoryLimit,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=64',              // limit process spawning
      '-v', `${scripts.runner}:/app/container-runner.mjs:ro`,  // mount runner script
      '-v', `${scripts.worker}:/app/container-worker.mjs:ro`,  // mount worker script
      '-w', '/app',
      this.image,
      'node', '/app/container-runner.mjs',
    ];

    this.process = spawn(this.runtime, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Forward stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[container] ${data.toString()}`);
    });

    this.process.on('exit', (code) => {
      this.ready = false;
      this.containerId = null;
      // Reject any pending execution
      if (this.pendingExecution) {
        clearTimeout(this.pendingExecution.timeoutHandle);
        this.pendingExecution.reject(
          new Error(`Container exited unexpectedly with code ${code}`)
        );
        this.pendingExecution = null;
      }
    });

    // Set up line reader on stdout
    this.readline = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.readline.on('line', (line) => this.handleMessage(line));

    // Wait for the "ready" message (generous timeout to allow image pull)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Container failed to become ready within 120s'));
      }, 120000);

      // Store resolve so handleMessage can call it when ready arrives
      this.readyResolve = () => {
        clearTimeout(timeout);
        this.ready = true;
        this.readyResolve = null;
        resolve();
      };

      // Handle startup failure
      this.process!.on('error', (err) => {
        clearTimeout(timeout);
        this.readyResolve = null;
        reject(new Error(`Failed to start container: ${err.message}`));
      });
    });
  }

  /**
   * Handle a line of JSON from the container's stdout.
   */
  private handleMessage(line: string): void {
    if (!line.trim()) return;

    let msg: ContainerMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[container-executor] bad JSON from container: ${line}\n`);
      return;
    }

    switch (msg.type) {
      case 'tool-call':
        this.handleToolCall(msg);
        break;

      case 'result':
        if (this.pendingExecution && this.pendingExecution.id === msg.id) {
          clearTimeout(this.pendingExecution.timeoutHandle);
          this.pendingExecution.resolve({
            result: msg.result,
            logs: msg.logs,
          });
          this.pendingExecution = null;
        }
        break;

      case 'error':
        if (this.pendingExecution && this.pendingExecution.id === msg.id) {
          clearTimeout(this.pendingExecution.timeoutHandle);
          this.pendingExecution.resolve({
            result: undefined,
            error: msg.error,
            logs: msg.logs,
          });
          this.pendingExecution = null;
        }
        break;

      case 'ready':
        if (this.readyResolve) {
          this.readyResolve();
        }
        break;
    }
  }

  /**
   * Dispatch a tool call from the container to the host-side tool function.
   */
  private async handleToolCall(msg: { id: string; name: string; args: unknown }): Promise<void> {
    if (!this.pendingExecution) {
      this.send({ type: 'tool-error', id: msg.id, error: 'No active execution context' });
      return;
    }

    const fns = this.pendingExecution.fns;
    const fn = fns[msg.name];

    if (!fn) {
      this.send({
        type: 'tool-error',
        id: msg.id,
        error: `Tool '${msg.name}' not found. Available tools: ${Object.keys(fns).join(', ')}`,
      });
      return;
    }

    try {
      const args = msg.args;
      const result = await fn(...(Array.isArray(args) ? args : [args]));
      this.send({ type: 'tool-result', id: msg.id, result });
    } catch (err) {
      this.send({
        type: 'tool-error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Send a message to the container via stdin.
   */
  private send(msg: HostMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Container stdin is not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Execute code inside the container.
   */
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    await this.init();

    if (this.pendingExecution) {
      return {
        result: undefined,
        error: 'Another execution is already in progress',
      };
    }

    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wrappedCode = wrapCode(code);

    return new Promise<ExecuteResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingExecution?.id === id) {
          this.pendingExecution = null;
          resolve({
            result: undefined,
            error: `Code execution timeout after ${this.timeout}ms`,
          });
        }
      }, this.timeout);

      this.pendingExecution = { id, resolve, reject, fns, timeoutHandle };
      this.send({ type: 'execute', id, code: wrappedCode });
    });
  }

  /**
   * Stop and clean up the container.
   */
  dispose(): void {
    if (this.pendingExecution) {
      clearTimeout(this.pendingExecution.timeoutHandle);
      this.pendingExecution.reject(new Error('Executor disposed'));
      this.pendingExecution = null;
    }

    if (this.process?.stdin?.writable) {
      try {
        this.send({ type: 'shutdown' });
      } catch {
        // ignore
      }
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 5 seconds if still alive
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
      this.process = null;
    }

    this.ready = false;
    this.initPromise = null;
  }
}

/**
 * Factory function matching the pattern of other executors.
 */
export function createContainerExecutor(options?: ContainerExecutorOptions): ContainerExecutor {
  return new ContainerExecutor(options);
}
