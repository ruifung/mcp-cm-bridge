import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Executor, ExecuteResult } from '@cloudflare/codemode';
import { wrapCode } from './wrap-code.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DenoExecutorOptions {
  /** Execution timeout per call in ms (default 30000) */
  timeout?: number;
  /** Deno executable path — 'deno' | auto-detect */
  denoPath?: string;
}

/** Messages sent from host → deno */
type HostMessage =
  | { type: 'execute'; id: string; code: string }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'tool-error'; id: string; error: string }
  | { type: 'shutdown' };

/** Messages sent from deno → host */
type DenoMessage =
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'result'; id: string; result: unknown; logs?: string[] }
  | { type: 'error'; id: string; error: string; logs?: string[] }
  | { type: 'ready' };

// ── Runtime detection ───────────────────────────────────────────────

function detectDeno(requested?: string): string {
  if (requested) return requested;

  // If we are already running on Deno, use the current executable path
  if (typeof (globalThis as any).Deno?.execPath === 'function') {
    return (globalThis as any).Deno.execPath();
  }

  // Try 'deno' command in PATH
  try {
    execSync('deno --version', { stdio: 'ignore' });
    return 'deno';
  } catch {
    // not available
  }

  throw new Error(
    'Deno executable not found. Install Deno or set DENO_PATH environment variable.'
  );
}

// ── Resolve runner script path ──────────────────────────────────────

function getScriptPaths(): { runner: string; worker: string } {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = __dirname;
  }
  return {
    runner: join(dir, 'container-runner.mjs'),
    worker: join(dir, 'container-worker.mjs'),
  };
}

// ── DenoExecutor ────────────────────────────────────────────────────

export class DenoExecutor implements Executor {
  private denoPath: string;
  private timeout: number;

  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private ready = false;
  private readyResolve: (() => void) | null = null;

  private pendingExecution: {
    id: string;
    resolve: (result: ExecuteResult) => void;
    reject: (error: Error) => void;
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
    timeoutHandle: NodeJS.Timeout;
  } | null = null;

  private initPromise: Promise<void> | null = null;

  constructor(options: DenoExecutorOptions = {}) {
    this.timeout = options.timeout ?? 30000;
    this.denoPath = detectDeno(options.denoPath);

    this.init().catch(err => {
      process.stderr.write(`[deno-executor] Immediate initialization failed: ${err.message}\n`);
    });
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const scripts = getScriptPaths();

    // Start a long-lived Deno process with restricted permissions
    const args = [
      'run',
      '--no-prompt',
      '--no-config',
      '--no-npm',
      '--no-remote',
      '--allow-read=' + scripts.runner + ',' + scripts.worker,
      '--deny-net',
      '--deny-write',
      '--deny-run',
      '--deny-env',
      '--deny-sys',
      '--deny-ffi',
    ];

    args.push(scripts.runner);

    this.process = spawn(this.denoPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[deno] ${data.toString()}`);
    });

    this.process.on('exit', (code) => {
      this.ready = false;
      if (this.pendingExecution) {
        clearTimeout(this.pendingExecution.timeoutHandle);
        this.pendingExecution.reject(
          new Error(`Deno process exited unexpectedly with code ${code}`)
        );
        this.pendingExecution = null;
      }
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.readline.on('line', (line) => this.handleMessage(line));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Deno process failed to become ready within 10s'));
      }, 10000);

      this.readyResolve = () => {
        clearTimeout(timeout);
        this.ready = true;
        this.readyResolve = null;
        resolve();
      };

      this.process!.on('error', (err) => {
        clearTimeout(timeout);
        this.readyResolve = null;
        reject(new Error(`Failed to start Deno: ${err.message}`));
      });
    });
  }

  private handleMessage(line: string): void {
    if (!line.trim()) return;

    let msg: DenoMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[deno-executor] bad JSON from deno: ${line}\n`);
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

  private send(msg: HostMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Deno stdin is not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

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
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2000);
      this.process = null;
    }

    this.ready = false;
    this.initPromise = null;
  }
}

export function createDenoExecutor(options?: DenoExecutorOptions): DenoExecutor {
  return new DenoExecutor(options);
}
