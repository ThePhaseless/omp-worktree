# ADR-0002: In-place process replacement via `process.execve` for relaunch

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

After creating/switching to a worktree, omp must run with a new `--cwd` /
`--session-dir` / `--fork` argument set. The plugin cannot change these for the
*current* process — they are parsed at startup — so a new omp process must take
over.

Options:

1. **Nested child process** (`Bun.spawn` of `omp …`, then exit). Leaves an
   orphaned parent shell context, doubles process state, and changes job-control
   semantics in the user's terminal.
2. **Print a command and ask the user to run it.** Loses the "seamless" goal.
3. **`process.execve`** — replace the current process image in place. The same
   terminal, same PID, no nesting; the new omp sees the new flags as if it were
   launched directly.

omp runs in script mode here (`omp` → `dist/cli.js`, shebang
`#!/usr/bin/env bun`), so `process.argv = [<bun>, <…/dist/cli.js>, …]`. To
re-exec while preserving the script slot, the new argv must be
`[<bun>, <dist/cli.js>, …flags]` (omp's own worker pattern: compiled →
`[execPath, arg]`, script → `[execPath, hostEntry, arg]`).

## Decision

Relaunch uses `process.execve(process.execPath, argv, env)` where `argv` keeps
the existing `process.argv[1]` (the `dist/cli.js` script path) when omp is in
script mode, otherwise drops it (compiled-binary mode). Before execve, raw
terminal mode is restored (`stdin.setRawMode(false)`) so the new process starts
with a clean terminal.

If `execve` throws (unavailable or fails in the real TUI), the plugin degrades
gracefully: it prints the exact `omp --cwd … --session-dir … [--fork …]` command
and calls `exit(0)`, so the user can run it manually. A secondary contingency is
`Bun.spawn({ cmd: [exe, …argv], stdio: ["inherit","inherit","inherit"] })` then
`process.exit(childCode)`, but the execve-then-print fallback already covers the
failure case.

## Consequences

- **Positive:** Seamless, same-terminal handoff; no nested shells or orphaned
  parents. The user experience is "omp restarted itself inside the worktree".
- **Positive:** Graceful fallback keeps the plugin robust if execve is ever
  unavailable; the user is never left with a half-started state.
- **Negative:** `process.execve` is platform-specific (present in Bun, not in
  plain Node/browser). The fallback path makes this non-fatal.
- **Negative:** The original process's in-memory state (loaded extensions,
  unsaved buffers) is discarded. This is acceptable because omp persists session
  state to disk and the forked session restores it.
