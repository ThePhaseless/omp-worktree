# omp-worktree-plugin

An [omp.sh](https://omp.sh) extension that adds native `git worktree` support via
a `/worktree` slash command. From an omp session running in a git repo, pick a
branch; the plugin creates a worktree for it and **omp itself moves into the
worktree** (re-execs in the same terminal) while **sharing the conversation with
the main folder**: the continued conversation is a fork stored in the main
repo's session bucket, so it appears in the session list of both folders.

## Install

```
omp plugin install github:ThePhaseless/omp-worktree-plugin
```

User scope — loads in the main repo and after moving into a worktree. Restart
any open omp after installing.

## Usage

- `/worktree` — interactive branch picker. Pick a local/remote branch or create a
  new one; omp relaunches inside the new worktree, continuing the conversation.
  - Picking an **existing non-current** local branch checks it out.
  - Picking the **current** branch or a **remote** branch creates a detached-HEAD
    worktree at that commit (no new branch name is asked for).
  - "➕ New branch…" prompts for a name and optional base, then creates that branch.
- `/worktree <branch>` — create a worktree for an existing branch. If `<branch>`
  is the current branch, detaches at HEAD.
- `/worktree --new <name> [<base>]` — create a new branch `<name>` (optionally
  based off `<base>`, default current HEAD) and a worktree for it. `-n` is an
  alias for `--new`.
- `/worktree list` — list all worktrees (markdown) in chat.
- `/worktree remove <target>` — remove a worktree (by path or branch). Prompts to
  confirm; add `--force` to remove a worktree with untracked/modified files.

`--at <path>` can be added to `checkout`/`new` to override the default worktree
location (a sibling of the main repo named `<repo>-wt-<branch>`).

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

- omp with extension support
- `git` on `PATH`

## Tests

```
bun test
```
