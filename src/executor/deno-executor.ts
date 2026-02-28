import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { RemoteExecutorBase } from './remote-executor-base.js';
import type { HostMessage } from './remote-executor-types.js';
import { getScriptPaths } from './script-paths.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DenoExecutorOptions {
  /** Execution timeout per call in ms (default 30000) */
  timeout?: number;
  /** Deno executable path — 'deno' | auto-detect */
  denoPath?: string;
}

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

// ── DenoExecutor ────────────────────────────────────────────────────

export class DenoExecutor extends RemoteExecutorBase {
  private denoPath: string;
  private process: ChildProcess | null = null;

  constructor(options: DenoExecutorOptions = {}) {
    super(options.timeout ?? 30000);
    this.denoPath = detectDeno(options.denoPath);

    this.init().catch(err => {
      process.stderr.write(`[deno-executor] Immediate initialization failed: ${err.message}\n`);
    });
  }

  protected async _init(): Promise<void> {
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

    args.push(scripts.runner, '--no-heartbeat', '--worker-path=' + scripts.worker);

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

  protected send(msg: HostMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Deno stdin is not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  protected onBadJson(line: string): void {
    process.stderr.write(`[deno-executor] bad JSON from deno: ${line}\n`);
  }

  protected onDisposeKill(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2000);
      this.process = null;
    }
  }
}

export function createDenoExecutor(options?: DenoExecutorOptions): DenoExecutor {
  return new DenoExecutor(options);
}
