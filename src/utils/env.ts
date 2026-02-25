/**
 * Environment detection utilities
 */

/**
 * Returns true if the current runtime is Node.js
 */
export function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    !!process.versions?.node &&
    !isBun() &&
    !isDeno()
  );
}

/**
 * Returns the Node.js major version, or 0 if not running on Node.js
 */
export function getNodeMajorVersion(): number {
  if (typeof process === 'undefined' || !process.versions?.node) {
    return 0;
  }
  return parseInt(process.versions.node.split('.')[0], 10);
}

/**
 * Returns true if the current runtime is Bun
 */
export function isBun(): boolean {
  return (
    typeof process !== 'undefined' &&
    !!(process as any).versions?.bun
  );
}

/**
 * Returns true if the current runtime is Deno
 */
export function isDeno(): boolean {
  return (
    (typeof globalThis !== 'undefined' && !!(globalThis as any).Deno) ||
    (typeof process !== 'undefined' && !!(process as any).versions?.deno)
  );
}

/**
 * Returns the name of the current runtime (Node.js, Bun, or Deno)
 */
export function getRuntimeName(): string {
  if (isBun()) return "Bun";
  if (isDeno()) return "Deno";
  if (isNode()) return "Node.js";
  return "Unknown";
}
