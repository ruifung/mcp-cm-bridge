import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { logDebug } from './logger.js';

/**
 * Resolves the Docker/Podman socket path.
 * 
 * 1. Respects DOCKER_HOST if set (returns undefined to let dockerode handle it).
 * 2. On Windows, defaults to the Docker Desktop named pipe.
 * 3. On Linux/Unix, checks common Docker and Podman (rootless/rootful) paths.
 * 4. Attempts to use 'podman info' to find the path.
 * 5. Falls back to letting dockerode handle defaults (returns undefined).
 */
export function resolveDockerSocketPath(): string | undefined {
  // If DOCKER_HOST is set, dockerode handles it automatically (via HTTP or custom path)
  if (process.env.DOCKER_HOST) {
    logDebug('DOCKER_HOST is set, letting dockerode handle it', { component: 'DockerUtils' });
    return undefined;
  }

  if (process.platform === 'win32') {
    // Check common Windows pipes
    const pipes = [
      '//./pipe/docker_engine',
      '//./pipe/podman-machine-default',
      '//./pipe/podman-machine-default-root'
    ];

    for (const pipe of pipes) {
      try {
        // In Node/Bun/Deno, we can check if a pipe exists using fs.statSync or similar,
        // but named pipes on Windows are tricky with existsSync.
        // However, dockerode's ping will eventually tell us if it works.
        // For now, we'll return the first one that exists or default to docker_engine.
        if (existsSync(pipe)) {
          logDebug(`Found named pipe at ${pipe}`, { component: 'DockerUtils' });
          return pipe;
        }
      } catch {
        // ignore
      }
    }

    return '//./pipe/docker_engine';
  }

  // Common locations on Linux/macOS
  const commonPaths = [
    '/var/run/docker.sock',
    `/run/user/${userInfo().uid}/podman/podman.sock`,
    '/run/podman/podman.sock',
  ];

  for (const path of commonPaths) {
    if (existsSync(path)) {
      logDebug(`Found socket at ${path}`, { component: 'DockerUtils' });
      return path;
    }
  }

  // Try querying podman CLI for the exact remote socket path
  try {
    const path = execSync('podman info --format "{{.Host.RemoteSocket.Path}}"', { 
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000 
    }).toString().trim();
    
    if (path) {
      logDebug(`Resolved socket via podman info: ${path}`, { component: 'DockerUtils' });
      return path;
    }
  } catch (err) {
    // podman CLI not available or info command failed
    logDebug('Podman CLI socket query failed', { component: 'DockerUtils' });
  }

  logDebug('No specific socket path resolved, using default /var/run/docker.sock', { component: 'DockerUtils' });
  return '/var/run/docker.sock';
}
