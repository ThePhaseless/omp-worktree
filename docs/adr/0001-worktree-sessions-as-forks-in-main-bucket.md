# ADR-0001: Worktree sessions are forks stored in the Main repo's session bucket

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

The plugin's goal is that entering a git worktree *continues* the current omp
conversation and that the resulting session is *shared* — it appears in the
session list of both the Main repo folder and the worktree folder.

omp keys sessions by an encoded cwd (`~/.omp/agent/sessions/<encoded-cwd>/…`).
Every native in-process cwd change (`/move`, `cd` in user bash) re-roots the
session into the new cwd's bucket. The pure cwd-change path is **not exposed to
extensions** (`ExtensionCommandContext` has no cwd-change API), and re-rooting
would move the session *out* of the Main bucket, breaking the "appears in both"
requirement.

The only way to get `cwd = worktree` while `session-dir = main-bucket` is to
launch a new omp process with `--cwd <worktree> --session-dir <main-bucket>`.
To *continue* the conversation without re-rooting the original file, omp's
`--fork <source-file>` flag builds a new `SessionManager(cwd=worktree,
dir=main)` that copies the full history and records `parentSession = source.id`.

## Decision

Entering a worktree relaunches omp with `--cwd <worktree>
--session-dir <main-bucket> --fork <current-session-file>`. The forked session:

- lives in the Main repo's session bucket (shared),
- has `header.cwd = <worktree>` (omp runs inside the worktree),
- copies the entire history (conversation continued),
- records the original session id as `parentSession` (lineage preserved),
- leaves the original session file untouched.

If the current session has no persisted file yet (no assistant reply), `--fork`
is omitted and a fresh session is created in the shared bucket.

Only the read-only `sessionManager.getSessionDir()` / `getSessionFile()` are
used at runtime — never `moveTo` / `switchSession` — which is exactly what keeps
the session in the Main bucket.

## Consequences

- **Positive:** The conversation continues seamlessly and is resumable from both
  folders. The original session is never mutated.
- **Positive:** No extension API for in-process cwd change is needed (none
  exists); the CLI route is sufficient.
- **Accepted side effect (D2):** After working in a worktree, `--continue` /
  auto-resume in the Main repo opens the most recent session — the worktree
  session — and moves into the worktree. This is native omp behavior and cannot
  be mitigated from a plugin. It is the natural consequence of storing the
  worktree session in the Main bucket and is acceptable: the user can branch or
  start a new session in the Main repo to return there.
- **Negative:** Resuming the *same* file from a different cwd without re-rooting
  is architecturally impossible (`setSessionFile` re-points when header cwd
  differs from launch cwd). Forking is the only continuation path; there is no
  "live move" of a session into a worktree.
