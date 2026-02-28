# Executors

The Code Mode Bridge supports four executor backends. On startup, it automatically selects the best available one based on what's available in the environment. You can force a specific executor via the `--executor` flag or `EXECUTOR_TYPE` environment variable.

## Selection Order (auto-detect)

| Priority | Executor | Selection Criteria |
|----------|--------------|------------------------------------------------------|
| 0 | `isolated-vm` | Node.js with V8 isolate support available |
| 1 | `deno` | `deno` binary found in PATH |
| 2 | `container` | Docker or Podman available (socket or CLI) |
| 3 | `vm2` | Node.js (fallback; not available under Bun) |

## Environment Variables

| Variable | Description |
|------|-------------|
| `EXECUTOR_TYPE` | Force a specific executor: `deno`, `isolated-vm`, `container`, or `vm2`. Throws if unavailable. |
| `CONTAINER_RUNTIME` | Override container runtime detection (e.g., `podman`, `/usr/bin/docker`). |

## Executor Comparison

| Feature | deno | isolated-vm | container | vm2 |
|---------|------|-------------|-----------|-----|
| JS-level sandboxing | Yes (Deno permissions) | Yes (V8 isolate) | No (full runtime inside) | Yes (VM2 sandbox) |
| Network isolation | Yes (`--deny-net`) | No APIs exposed | OS-level (`--network=none`) | No APIs exposed |
| File system isolation | Yes (`--deny-read`) | No APIs exposed | OS-level (`--read-only`) | No APIs exposed |
| `require`/`process` blocked | Yes | Yes | No (sandbox boundary) | Yes |
| Concurrency | Serialized | Parallel | Serialized (one-at-a-time) | Parallel |
| Startup overhead | Medium | Low | Higher (container + worker thread) | Low |
| Security model | Deno permissions | V8 process isolation | Container boundary | JS context isolation |

## Container Executor

The container executor automatically selects between direct socket communication (via Dockerode) or a CLI fallback (`docker` or `podman` command).

Each container runs with:

```
--network=none --read-only --cap-drop=ALL --user=node
--tmpfs /tmp:rw,noexec,nosuid,size=64m
--pids-limit=64 --memory=256m --cpus=1.0
```

## Security Hardening

For detailed information on how we secure the sandbox environments, see [Sandbox Hardening](./sandbox-hardening.md).
