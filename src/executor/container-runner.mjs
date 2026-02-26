/**
 * Container runner script — main thread that owns the stdio protocol.
 *
 * Runs inside the container. For each "execute" request, spawns a
 * worker_thread (container-worker.mjs) to eval the code. This ensures
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

// ── Top-level error handlers ────────────────────────────────────────
// Must be registered before anything else so that startup failures
// (e.g., missing module, syntax error) are reported to the host rather
// than silently hanging the ready-signal wait.

function reportFatalError(err) {
  const payload = JSON.stringify({
    type: 'error',
    error: {
      message: err?.message ?? String(err),
      stack: err?.stack ?? '',
      name: err?.name ?? 'Error',
    },
  });
  try {
    process.stdout.write(payload + '\n');
  } catch { /* stdout may be gone — nothing we can do */ }
  process.stderr.write(`[container-runner] Fatal error: ${err?.stack ?? err}\n`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  reportFatalError(err);
});

process.on('unhandledRejection', (reason) => {
  reportFatalError(reason instanceof Error ? reason : new Error(String(reason)));
});

process.stderr.write('[container-runner] Starting...\n');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, 'container-worker.mjs');

// ── Active worker state ─────────────────────────────────────────────

/** @type {Worker | null} */
let activeWorker = null;
/** @type {string | null} */
let activeExecutionId = null;

// ── Protocol helpers ────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Execute code in a worker thread ─────────────────────────────────

function executeCode(id, code) {
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

  worker.on('message', (msg) => {
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
        process.stderr.write(`[runner] unknown worker message type: ${msg.type}\n`);
    }
  });

  // ── Worker crash / exit ───────────────────────────────────────
  worker.on('error', (err) => {
    send({
      type: 'error',
      id,
      error: `Worker thread error: ${err.message}`,
    });
    cleanup();
  });

  worker.on('exit', (exitCode) => {
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

function cleanup() {
  activeWorker = null;
  activeExecutionId = null;
}

// ── Message dispatcher ──────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
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
      if (activeWorker) {
        activeWorker.terminate();
        cleanup();
      }
      process.exit(0);
      break;

    default:
      process.stderr.write(`[runner] unknown message type: ${msg.type}\n`);
  }
}

// ── Stdin reader ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  process.stderr.write('[container-runner] Received message: ' + line.substring(0, 100) + '\n');
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch (err) {
    process.stderr.write(`[runner] failed to parse message: ${err.message}\n`);
  }
});

rl.on('close', () => {
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
