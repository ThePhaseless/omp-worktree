# omp-worktree

An [omp.sh](https://omp.sh) extension that adds native `git worktree` support via
a `/worktree` slash command. From an omp session running in a git repo, pick a
branch; the plugin creates a worktree for it and **omp itself moves into the
worktree** (re-execs in the same terminal) while **sharing the conversation with
the main folder**: the continued conversation is a fork stored in the main
repo's session bucket, so it appears in the session list of both folders.

## Install

```
omp plugin install github:ThePhaseless/omp-worktree
```

Restart any open omp after installing.

## Usage

### Interactive

```
/worktree
```

Pick a branch from the list of local and remote branches. Then type a branch
name:

- **Empty** — check out the selected branch as-is in a new worktree.
  - If the branch is already checked out in an existing worktree, switches into
    it instead of creating a new one.
  - If you're already in the worktree where it's checked out, warns and returns.
  - Remote branches create a local tracking branch with an auto-defaulted name
    (`origin/x` → `x`); if that name already exists locally, it is checked out
    directly without prompting.
- **Non-empty** — create a new branch with that name, based off the selected
  branch, and a worktree for it.
- **Esc** — go back to the branch picker.

Branches are listed in priority order: the current branch, remote versions of
the current branch, the primary branch (`origin/HEAD`, falling back to
`main`/`master`), remote versions of the primary branch, then everything else.

### Non-interactive

- `/worktree <branch>` — create a worktree for an existing branch. If the branch
  is already checked out in a worktree, switches into it instead.
- `/worktree --new <name> [<base>]` — create a new branch `<name>` (optionally
  based off `<base>`, default current HEAD) and a worktree for it. `-n` is an
  alias for `--new`.
- `/worktree list` — list all worktrees in chat.
- `/worktree remove <target>` — remove a worktree by path or branch name. Prompts
  to confirm; add `--force` to remove a worktree with untracked/modified files.

`--at <path>` can be added to `<branch>` or `--new` to override the default
worktree location (a sibling of the main repo named `<repo>-wt-<branch>`).

### Checks

- **Dirty repo** — if the main repo has uncommitted/untracked files, you're told
  the count and asked to confirm (they won't exist in the new worktree).
- **Path collision** — if the default worktree path already exists, you're
  prompted for an alternative (default `<path>-2`).
- **Branch name collision** — if a new branch name already exists locally, the
  existing branch is checked out in the new worktree automatically (no
  prompt).

## Shared-conversation behavior

Entering a worktree **forks** the current session into the main repo's session
bucket: the full history is copied, the original session is preserved, and the
new session records the original as its parent. The new omp process runs with
`cwd` inside the worktree but its session file lives in the main repo's bucket,
so it shows up in `--resume` from both the main repo and the worktree folder.

If the current session has not been persisted to disk yet (no assistant reply),
the fork step is skipped and a fresh shared session is started instead.

See [`CONTEXT.md`](./CONTEXT.md) for the domain glossary and
[`docs/adr/`](./docs/adr) for the architectural decisions.

## Requirements

- [omp](https://omp.sh) with extension support
- `git` on `PATH`

## Tests

```
bun test
```

## License

MIT
