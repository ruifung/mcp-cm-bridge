/**
 * Container worker script — runs inside a worker_thread, spawned by
 * container-runner.mjs for each code execution request.
 *
 * Responsibilities:
 *   1. Receive { code } from parent via workerData
 *   2. Set up captured console (log/warn/error/info/debug)
 *   3. Create codemode proxy that sends tool-call messages to parent
 *      via parentPort and waits for tool-result/tool-error replies
 *   4. Eval the code (indirect eval in global scope)
 *   5. Send { type: 'result' | 'error', ... } back to parent
 *
 * Communication with parent (container-runner.mjs main thread):
 *   Worker → Parent:
 *     { type: 'tool-call', id, name, args }
 *     { type: 'result', result, logs }
 *     { type: 'error', error, logs }
 *
 *   Parent → Worker:
 *     { type: 'tool-result', id, result }
 *     { type: 'tool-error',  id, error }
 */

import { parentPort, workerData } from 'node:worker_threads';

const { code } = workerData;

// ── State ───────────────────────────────────────────────────────────

let pendingToolCalls = new Map();   // id -> { resolve, reject }
let toolCallCounter = 0;
let logs = [];

// ── Console capture ─────────────────────────────────────────────────

function stringify(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return Object.prototype.toString.call(value); }
}

const capturedConsole = {
  log:   (...args) => { logs.push(args.map(stringify).join(' ')); },
  warn:  (...args) => { logs.push('[WARN] '  + args.map(stringify).join(' ')); },
  error: (...args) => { logs.push('[ERROR] ' + args.map(stringify).join(' ')); },
  info:  (...args) => { logs.push(args.map(stringify).join(' ')); },
  debug: (...args) => { logs.push('[DEBUG] ' + args.map(stringify).join(' ')); },
};

// Replace global console in this worker thread
globalThis.console = capturedConsole;

// ── Codemode proxy (tool RPC via parentPort) ────────────────────────

function createCodemodeProxy() {
  return new Proxy({}, {
    get(_target, prop) {
      const name = String(prop);
      if (typeof prop === 'symbol') return undefined;
      if (name === 'then') return undefined;
      if (name === 'toJSON') return undefined;

      return (...args) => {
        const id = `tc-${++toolCallCounter}`;
        return new Promise((resolve, reject) => {
          pendingToolCalls.set(id, { resolve, reject });
          parentPort.postMessage({
            type: 'tool-call',
            id,
            name,
            args: args.length === 1 ? args[0] : args,
          });
        });
      };
    },
  });
}

globalThis.codemode = createCodemodeProxy();

// ── Handle messages from parent (tool results) ─────────────────────

parentPort.on('message', (msg) => {
  if (msg.type === 'tool-result') {
    const pending = pendingToolCalls.get(msg.id);
    if (pending) {
      pendingToolCalls.delete(msg.id);
      pending.resolve(msg.result);
    }
  } else if (msg.type === 'tool-error') {
    const pending = pendingToolCalls.get(msg.id);
    if (pending) {
      pendingToolCalls.delete(msg.id);
      pending.reject(new Error(msg.error));
    }
  }
});

// ── Execute the code ────────────────────────────────────────────────

async function run() {
  try {
    const indirectEval = eval;
    const result = await indirectEval(code);

    parentPort.postMessage({
      type: 'result',
      result: result ?? null,
      logs: logs.length ? logs : undefined,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({
      type: 'error',
      error,
      logs: logs.length ? logs : undefined,
    });
  }
}

run();
