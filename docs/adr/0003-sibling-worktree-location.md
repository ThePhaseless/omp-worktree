# ADR-0003: New worktrees are placed as siblings of the Main repo

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

`git worktree add <path> <branch>` can place a linked worktree anywhere on
disk. The choice of default location affects discoverability, the shared-session
design, and the dirty-repo/path-collision UX.

Options:

1. **Inside the Main repo** (e.g. `<main>/.worktrees/<branch>`). Contaminates the
   Main repo's working tree — shows up in `git status`, risks accidental commits,
   and interacts badly with the dirty-repo check.
2. **A fixed external dir** (e.g. `~/.omp-worktrees/<repo>/<branch>`).
   Discoverable but disconnects the worktree from the repo on disk and complicates
   the "sibling" mental model.
3. **Sibling of the Main repo** (`<parent>/<repo>-wt-<branch>`). Lives next to
   the Main repo, clearly named, outside its working tree, and trivially
   discoverable.

## Decision

The default worktree path is `path.join(path.dirname(mainRoot),
path.basename(mainRoot) + "-wt-" + sanitizeBranchName(branch))` — a sibling of
the Main repo. `mainRoot` is resolved via `git rev-parse --git-common-dir`
(which works from the Main repo *and* from a nested linked worktree, since the
common dir always points at the Main repo's `.git`), so the new worktree is
always a sibling of the *Main* repo, not of the current working tree.

The user can override the location with `--at <path>`.

## Consequences

- **Positive:** No contamination of the Main repo's working tree.
- **Positive:** Predictable, self-documenting path; works identically whether
  invoked from the Main repo or from an existing (nested) worktree.
- **Positive:** Keeps the session bucket anchored to the Main repo (D1/D4),
  because the Main repo is resolved from the common dir, not from `cwd`.
- **Negative:** Requires write permission to the Main repo's parent directory.
  If that is not writable, the user must pass `--at <path>` to a writable
  location.
- **Negative:** A very long branch name produces a long sibling directory name;
  `sanitizeBranchName` collapses invalid characters but does not truncate. Rare
  in practice; `--at` is the escape hatch.
