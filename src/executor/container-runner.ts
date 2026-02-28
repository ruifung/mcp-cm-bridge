/**
 * Container runner script — main thread that owns the stdio protocol.
 *
 * Runs inside the container. For each "execute" request, spawns a
 * worker_thread (container-worker.ts) to eval the code. This ensures
 * that user code cannot interfere with the main thread's event loop,
 * globals, or the protocol stream.
 *
 * If the worker crashes or hangs, the main thread can terminate it
 * and report an error back to the host.
 *
 * Protocol: line-delimited JSON over stdin/stdout.
 *
 * Host -> Container (stdin):
 *   { "type": "execute", "id": "<id>", "code": "<js code>" }
 *   { "type": "tool-result", "id": "<call-id>", "result": <value> }
 *   { "type": "tool-error",  "id": "<call-id>", "error": "<message>" }
 *   { "type": "shutdown" }
 *
 * Container -> Host (stdout):
 *   { "type": "tool-call", "id": "<call-id>", "name": "<tool>", "args": <value> }
 *   { "type": "result", "id": "<id>", "result": <value>, "logs": [...] }
 *   { "type": "error",  "id": "<id>", "error": "<message>", "logs": [...] }
 *   { "type": "ready" }
 */

import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

/** Messages sent from host → container (stdin) */
type HostMessage =
  | { type: 'execute'; id: string; code: string }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'tool-error'; id: string; error: string }
  | { type: 'heartbeat' }
  | { type: 'shutdown' };

/** Messages sent from worker → runner */
type WorkerMessage =
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'result'; id: string; result: unknown; logs?: string[] }
  | { type: 'error'; id: string; error: string; logs?: string[] };

// ── Constants ───────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 15_000; // 3x the 5s host interval

// ── Top-level error handlers ────────────────────────────────────────
// Must be registered before anything else so that startup failures
// (e.g., missing module, syntax error) are reported to the host rather
// than silently hanging the ready-signal wait.

function reportFatalError(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const payload = JSON.stringify({
    type: 'error',
    error: {
      message: e.message,
      stack: e.stack ?? '',
      name: e.name,
    },
  });
  try {
    process.stdout.write(payload + '\n');
  } catch { /* stdout may be gone — nothing we can do */ }
  process.stderr.write(`[container-runner] Fatal error: ${e.stack ?? e}\n`);
  process.exit(1);
}

process.on('uncaughtException', (err: Error) => {
  reportFatalError(err);
});

process.on('unhandledRejection', (reason: unknown) => {
  reportFatalError(reason instanceof Error ? reason : new Error(String(reason)));
});

process.stderr.write('[container-runner] Starting...\n');

const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = dirname(__filename);

// Worker path may be supplied via --worker-path=<path> CLI arg; falls back to
// a sibling container-worker.ts resolved relative to this script.
const workerPathArg: string | undefined = process.argv
  .find(a => a.startsWith('--worker-path='))
  ?.slice('--worker-path='.length);
const WORKER_PATH: string = workerPathArg ?? join(__dirname, 'container-worker.ts');

// ── Active worker state ─────────────────────────────────────────────

let activeWorker: Worker | null = null;
let activeExecutionId: string | null = null;

// ── Heartbeat watchdog state ────────────────────────────────────────

let lastHeartbeat: number = Date.now();
let heartbeatWatchdog: ReturnType<typeof setInterval> | null = null;

// ── Protocol helpers ────────────────────────────────────────────────

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Execute code in a worker thread ─────────────────────────────────

function executeCode(id: string, code: string): void {
  // If there's already a worker running, reject
  if (activeWorker) {
    send({
      type: 'error',
      id,
      error: 'Another execution is already in progress',
    });
    return;
  }

  activeExecutionId = id;

  const worker = new Worker(WORKER_PATH, {
    workerData: { code },
  });

  activeWorker = worker;

  // ── Worker message handler ──────────────────────────────────────
  // The worker sends three message types:
  //   tool-call  -> forward to host via stdout
  //   result     -> forward to host, then clean up
  //   error      -> forward to host, then clean up

  worker.on('message', (msg: WorkerMessage) => {
    switch (msg.type) {
      case 'tool-call':
        // Forward tool call from worker to host
        send({ type: 'tool-call', id: msg.id, name: msg.name, args: msg.args });
        break;

      case 'result':
        // Worker finished successfully
        send({ type: 'result', id, result: msg.result, logs: msg.logs });
        cleanup();
        break;

      case 'error':
        // Worker reported an error
        send({ type: 'error', id, error: msg.error, logs: msg.logs });
        cleanup();
        break;

      default:
        process.stderr.write(`[runner] unknown worker message type: ${(msg as WorkerMessage).type}\n`);
    }
  });

  // ── Worker crash / exit ───────────────────────────────────────
  worker.on('error', (err: Error) => {
    send({
      type: 'error',
      id,
      error: `Worker thread error: ${err.message}`,
    });
    cleanup();
  });

  worker.on('exit', (exitCode: number) => {
    // Only report if we haven't already sent a result/error
    if (activeWorker === worker) {
      if (exitCode !== 0) {
        send({
          type: 'error',
          id,
          error: `Worker thread exited with code ${exitCode}`,
        });
      }
      cleanup();
    }
  });
}

function cleanup(): void {
  activeWorker = null;
  activeExecutionId = null;
}

// ── Message dispatcher ──────────────────────────────────────────────

function handleMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'heartbeat':
      lastHeartbeat = Date.now();
      return;

    case 'execute':
      executeCode(msg.id, msg.code);
      break;

    case 'tool-result':
    case 'tool-error':
      // Forward tool results from host to the active worker
      if (activeWorker) {
        activeWorker.postMessage(msg);
      } else {
        process.stderr.write(
          `[runner] received ${msg.type} but no active worker\n`
        );
      }
      break;

    case 'shutdown':
      // Terminate any active worker, then exit
      if (heartbeatWatchdog) {
        clearInterval(heartbeatWatchdog);
        heartbeatWatchdog = null;
      }
      if (activeWorker) {
        activeWorker.terminate();
        cleanup();
      }
      process.exit(0);
      break;

    default:
      process.stderr.write(`[runner] unknown message type: ${(msg as HostMessage).type}\n`);
  }
}

// ── Stdin reader ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  if (!line.trim()) return;
  process.stderr.write('[container-runner] Received message: ' + line.substring(0, 100) + '\n');
  try {
    const msg = JSON.parse(line) as HostMessage;
    handleMessage(msg);
  } catch (err) {
    process.stderr.write(`[runner] failed to parse message: ${(err as Error).message}\n`);
  }
});

rl.on('close', () => {
  if (heartbeatWatchdog) {
    clearInterval(heartbeatWatchdog);
    heartbeatWatchdog = null;
  }
  if (activeWorker) {
    activeWorker.terminate();
    cleanup();
  }
  process.exit(0);
});

// ── Signal readiness ────────────────────────────────────────────────

process.stderr.write('[container-runner] Sending ready signal...\n');
send({ type: 'ready' });
process.stderr.write('[container-runner] Ready signal sent\n');

// Allow callers to opt-out of the heartbeat watchdog via --no-heartbeat flag.
// When disabled the subprocess still runs normally but will not self-terminate
// due to missed heartbeats.
const noHeartbeat: boolean = process.argv.includes('--no-heartbeat');

if (noHeartbeat) {
  process.stderr.write('[container-runner] Heartbeat watchdog disabled (--no-heartbeat)\n');
} else {
  // Start heartbeat watchdog — if host stops sending heartbeats, self-terminate
  heartbeatWatchdog = setInterval(() => {
    const elapsed: number = Date.now() - lastHeartbeat;
    if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      process.stderr.write(`[container-runner] No heartbeat from host for ${elapsed}ms, self-terminating\n`);
      if (activeWorker) {
        try { activeWorker.terminate(); } catch { /* ignore */ }
      }
      clearInterval(heartbeatWatchdog!);
      process.exit(1);
    }
  }, 5_000); // check every 5 seconds
}
