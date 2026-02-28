import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScriptPaths {
  runner: string;
  worker: string;
}

/**
 * Resolves the paths to the container runner and worker scripts.
 *
 * Resolution: probes for `.ts` first (source/dev), falls back to `.js` (compiled dist).
 */
export function getScriptPaths(): ScriptPaths {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback
    // @ts-ignore
    dir = __dirname;
  }

  return {
    runner: resolveScript(join(dir, 'remote-runner')),
    worker: resolveScript(join(dir, 'remote-worker')),
  };
}

function resolveScript(base: string): string {
  const ts = `${base}.ts`;
  if (existsSync(ts)) return ts;
  return `${base}.js`;
}
