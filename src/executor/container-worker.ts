/**
 * Container worker script — runs inside a worker_thread, spawned by
 * container-runner.ts for each code execution request.
 *
 * Responsibilities:
 *   1. Receive { code } from parent via workerData
 *   2. Set up captured console (log/warn/error/info/debug)
 *   3. Create codemode proxy that sends tool-call messages to parent
 *      via parentPort and waits for tool-result/tool-error replies
 *   4. Eval the code (indirect eval in global scope)
 *   5. Send { type: 'result' | 'error', ... } back to parent
 *
 * Communication with parent (container-runner.ts main thread):
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

// ── Types ────────────────────────────────────────────────────────────

interface WorkerData {
  code: string;
}

interface ToolCallMessage {
  type: 'tool-call';
  id: string;
  name: string;
  args: unknown;
}

interface ToolResultMessage {
  type: 'tool-result';
  id: string;
  result: unknown;
}

interface ToolErrorMessage {
  type: 'tool-error';
  id: string;
  error: string;
}

type ParentInboundMessage = ToolResultMessage | ToolErrorMessage;

interface PendingToolCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// ── Initialise ───────────────────────────────────────────────────────

const { code } = workerData as WorkerData;

// ── State ───────────────────────────────────────────────────────────

const pendingToolCalls = new Map<string, PendingToolCall>();
let toolCallCounter: number = 0;
const logs: string[] = [];

// ── Console capture ─────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return Object.prototype.toString.call(value); }
}

const capturedConsole = {
  log:   (...args: unknown[]): void => { logs.push(args.map(stringify).join(' ')); },
  warn:  (...args: unknown[]): void => { logs.push('[WARN] '  + args.map(stringify).join(' ')); },
  error: (...args: unknown[]): void => { logs.push('[ERROR] ' + args.map(stringify).join(' ')); },
  info:  (...args: unknown[]): void => { logs.push(args.map(stringify).join(' ')); },
  debug: (...args: unknown[]): void => { logs.push('[DEBUG] ' + args.map(stringify).join(' ')); },
};

// Replace global console in this worker thread
(globalThis as typeof globalThis & { console: typeof console }).console = capturedConsole as typeof console;

// ── Codemode proxy (tool RPC via parentPort) ────────────────────────

function createCodemodeProxy(): object {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_target: Record<string | symbol, unknown>, prop: string | symbol): unknown {
      const name = String(prop);
      if (typeof prop === 'symbol') return undefined;
      if (name === 'then') return undefined;
      if (name === 'toJSON') return undefined;

      return (...args: unknown[]): Promise<unknown> => {
        const id = `tc-${++toolCallCounter}`;
        return new Promise<unknown>((resolve, reject) => {
          pendingToolCalls.set(id, { resolve, reject });
          parentPort!.postMessage({
            type: 'tool-call',
            id,
            name,
            args: args.length === 1 ? args[0] : args,
          } satisfies ToolCallMessage);
        });
      };
    },
  });
}

type GlobalWithExtras = typeof globalThis & {
  codemode: object;
  Function: typeof Function;
};

(globalThis as GlobalWithExtras).codemode = createCodemodeProxy();

// ── Sandbox hardening ───────────────────────────────────────────────
// Save reference to eval before overriding — the worker uses indirect eval
// to execute user code in run().
const _savedEval: typeof eval = eval;

// 1. Block eval from user code
Object.defineProperty(globalThis, 'eval', {
  value: function(): never { throw new Error('eval is not allowed'); },
  writable: false, enumerable: false, configurable: false,
});

// 2. Block Function constructor (equivalent to eval)
{
  const OrigFunction = Function;
  function BlockedFunction(this: unknown): never { throw new Error('Function constructor is not allowed'); }
  BlockedFunction.prototype = OrigFunction.prototype;
  (globalThis as GlobalWithExtras).Function = BlockedFunction as unknown as typeof Function;
}

// 3. Make codemode non-configurable & non-writable
Object.defineProperty(globalThis, 'codemode', {
  value: (globalThis as GlobalWithExtras).codemode,
  writable: false,
  configurable: false,
  enumerable: true,
});

// ── Handle messages from parent (tool results) ─────────────────────

parentPort!.on('message', (msg: ParentInboundMessage) => {
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

async function run(): Promise<void> {
  try {
    const result: unknown = await _savedEval(code);

    parentPort!.postMessage({
      type: 'result',
      result: result ?? null,
      logs: logs.length ? logs : undefined,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({
      type: 'error',
      error,
      logs: logs.length ? logs : undefined,
    });
  }
}

run();
