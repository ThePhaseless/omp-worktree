# Domain Glossary — omp-worktree

Canonical vocabulary for the omp git-worktree plugin. Terms only; no implementation.

## Terms

- **Main repo** — The primary git repository working directory (the one whose
  `.git` directory is the *common* dir). `git worktree` calls this the "main
  worktree". It is the only worktree that can contain a bare repository's
  checkout and the one whose `.git` is a real directory (linked worktrees have a
  `.git` *file* pointing at `commondir/gitdir`). The plugin keys shared sessions
  to the Main repo's session bucket.

- **Linked worktree** — A secondary working tree created by
  `git worktree add`. It shares the Main repo's object database and refs but has
  its own working directory and checked-out branch (HEAD). Its `.git` is a file,
  not a directory, pointing into `<main>/.git/worktrees/<name>`. omp moves *into*
  a linked worktree while keeping its session stored in the Main repo's bucket.

- **Base branch** — The ref a new branch (and thus a new worktree) is created
  from. For an existing local branch there is no base — the worktree checks out
  that branch directly. For a new branch (`--new <name> [<base>]` or the
  interactive "New branch…" flow) the base is the starting point; the default is
  the current HEAD.

- **Session bucket** — The on-disk directory omp stores session files for a
  given working directory: `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl`.
  omp keys sessions by an encoded cwd, so a worktree's own cwd would normally
  produce its own bucket. The plugin deliberately keeps the worktree session in
  the *Main* repo's bucket so the conversation appears in both folders' session
  lists.

- **Shared session** — A session whose file lives in the Main repo's session
  bucket even though the omp process is running with its working directory inside
  a linked worktree. Achieved by launching omp with `--cwd <worktree>
  --session-dir <main-bucket>`. The session is resumable/visible from both the
  Main repo folder and the worktree folder.

- **Forked conversation** — A session created with omp's `--fork <source-file>`
  flag: a brand-new session file that copies the *entire history* of the source
  and records the source's id as `parentSession`. The original session is left
  untouched. The plugin forks (rather than resumes) so entering a worktree
  *continues* the conversation without re-pointing/re-rooting the original
  session file — which would be required to resume the same file from a
  different cwd and is not available to extensions.

- **Relaunch** — Replacing the current omp process in place with a new omp
  process whose `--cwd`/`--session-dir`/`--fork` flags point at the worktree and
  the shared bucket. Done via `process.execve` so the same terminal is reused
  (no nested shell, no orphaned parent). If execve fails, the plugin prints the
  exact manual command and exits cleanly.

## Resolved decisions (baked into the design)

- **D1 — Fork, don't resume.** Entering a worktree continues the conversation as
  a fork in the Main bucket (full history, parent lineage, original preserved).
  If the current session has no persisted file yet, `--fork` is omitted and a
  fresh session is created in the shared bucket. Resuming the same file from a
  different cwd is architecturally impossible without re-rooting, so fork is the
  only way to both continue and share.

- **D2 — Auto-resume side effect accepted.** After working in a worktree,
  `--continue`/auto-resume in the Main repo opens the most recent session — which
  is the worktree session — and moves into the worktree. This is native omp
  behavior and not mitigable from a plugin. Documented in ADR-0001.

- **D3 — Current-branch pick switches to the existing worktree.** A branch is
  single-checkout, so picking the currently-checked-out branch cannot create a
  second worktree for it. The plugin finds the worktree where that branch is
  already checked out and switches into it. If that worktree is the current cwd,
  it warns and returns. No new branch name is asked for.

- **D4 — Nested worktrees allowed.** Resolution via `git rev-parse
  --git-common-dir` makes the new worktree a sibling of the Main repo and keeps
  the session in the Main bucket regardless of how deeply nested the current
  working tree is.

- **D5 — Surface = create/switch + list + remove.** `/worktree` (interactive),
  `/worktree <branch>`, `/worktree --new <name> [<base>]`, `/worktree list`,
  `/worktree remove <target>`.

- **D6 — In-place `process.execve` relaunch with graceful fallback.** Replaces
  the image in the same terminal. On failure: print the exact `omp …` command and
  `exit(0)`. See ADR-0002.

- **D7 — Dirty repo warns + confirms (proceed default).** Uncommitted/untracked
  files in the Main repo won't exist in the new worktree; the user is told the
  count and asked to confirm.
- **D8 — Remote branches auto-create a local tracking branch.** Picking a
  remote ref creates a local tracking branch with a defaulted name (`origin/x`
  → `x`), no prompt. Commits land on a real branch.

- **D9 — Path-collision preflight.** If the planned worktree path already exists
  and is not already a worktree, prompt for an alternative (default `<path>-2`).

- **D10 — Delivered as a new public GitHub repo.** `ThePhaseless/omp-worktree`;
  install via `omp plugin install github:ThePhaseless/omp-worktree`.
