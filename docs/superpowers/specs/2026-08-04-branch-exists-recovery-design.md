# Design: Branch-Exists Recovery for `git worktree add -b`

Date: 2026-08-04 · Status: approved for planning

## Problem

`git worktree add -b <name> <path> [<base>]` fails with
`fatal: a branch named '<name>' already exists` whenever local ref
`refs/heads/<name>` exists but is not checked out in any worktree. The plugin
currently catches this at the single `addWorktree` call site in
`runWorktreeCommand` and prints the raw git stderr, leaving the user with no
path forward.

Three entry points reach this failure:

1. **Interactive, typed name** — user picks a branch, types a new branch name
   that collides with an existing local branch.
2. **Interactive, remote pick + empty input** — user picks `origin/x`; the
   auto-defaulted local name `x` (D8) already exists locally.
3. **CLI** — `/worktree --new <name> [<base>]` where `<name>` exists locally.

## Grounded facts

- **Single-checkout rule (verified empirically).** A branch can be checked out
  in at most one worktree; a second `git worktree add <path> <branch>` fails
  with `fatal: '<branch>' is already used by worktree at '<path>'`. The
  existing-worktree fast path in `runWorktreeCommand` already routes every
  branch that is checked out somewhere (D3), so when the `-b` fatal fires the
  colliding branch is checked out *nowhere* — a plain checkout of it at the
  planned path is always legal.
- **No leftover directory (verified empirically).** `git worktree add -b` dies
  on the branch-name validation before creating the worktree directory, so
  retrying the same path needs no re-run of the D9 path-collision preflight.
- Fatal format is exactly `fatal: a branch named '<name>' already exists`
  (straight quotes, name verbatim; exit 255). `addWorktree` throws
  `new Error(stderr.trim())`, so the catch block sees the fatal line as the
  message.

## Behavior

When `addWorktree` fails in `new` mode and the message matches
`/^fatal: a branch named '(.+)' already exists$/` with the captured name equal
to `mode.name`:

| Name origin | Behavior |
|---|---|
| Explicit — interactive typed name, or CLI `/worktree --new <name>` | Prompt: *"Branch `<name>` already exists — check it out in the new worktree instead?"*. **Accept** → retry `git worktree add <path> <name>` (plain checkout, no `-b`) at the same path, then `relaunchInto(path)` as usual. **Decline** → display the original git error and return. |
| Auto-defaulted — interactive remote pick + empty input (`origin/x` → `x`) | **Auto-recover, no prompt**: display an info note (*"Branch `x` already exists locally — checking it out"*), retry the plain checkout, relaunch. |

- Non-collision `addWorktree` failures keep the current behavior (display
  error, return) — never prompt.
- If the recovery checkout itself fails (rare race, e.g. the branch was checked
  out elsewhere mid-flight), display that error and return; no second prompt.
- The existing "switch into existing worktree" fast-path confirm (D3) is
  unchanged — it is a *move* decision, not a creation recovery.

## Implementation

### `src/git.ts`

Add one exported helper next to `addWorktree`:

```ts
/**
 * If the error message is git's `-b` branch-name-collision fatal, return the
 * colliding branch name; otherwise undefined.
 */
export function branchExistsInAddError(message: string): string | undefined {
	const m = message.match(/^fatal: a branch named '(.+)' already exists$/);
	return m ? m[1] : undefined;
}
```

### `src/command.ts`

1. Extend `Mode` so the recovery can distinguish name origins:

```ts
type Mode =
	| { kind: "checkout"; branch: string }
	| { kind: "new"; name: string; baseRef?: string; autoNamed?: boolean };
```

2. In the interactive flow, set `autoNamed: true` only in the remote-pick
   branch (empty input, auto-defaulted tracking-branch name). Typed names and
   the `--new` CLI path leave it unset.

3. Replace the `addWorktree` catch block with:

```ts
} catch (e) {
	const msg = (e as Error).message;
	if (mode.kind === "new" && branchExistsInAddError(msg) === mode.name) {
		const proceed =
			mode.autoNamed ||
			(await deps.ui.confirm("Branch exists", `Branch ${mode.name} already exists — check it out in the new worktree instead?`));
		if (proceed) {
			if (mode.autoNamed) deps.display(`${deps.symbols("status.warning")} Branch ${mode.name} already exists locally — checking it out`);
			try {
				await addWorktree(mainRoot, deps.run, { path: at, branch: mode.name });
			} catch (e2) {
				deps.display(`${deps.symbols("status.warning")} ${(e2 as Error).message}`);
				return;
			}
			relaunchInto(at);
			return;
		}
	}
	deps.display(`${deps.symbols("status.warning")} ${msg}`);
	return;
}
```

## Testing

Extend the `test/command.test.ts` harness: add `addFailStderr?: string` to
`RunOpts` — the *first* `worktree add` call fails with that stderr, subsequent
calls succeed (a counter inside `makeRun`). Keep `addFails` for always-fail
cases.

New tests:

1. **Auto-recover (empty-input remote pick).** Interactive, select `origin/x`,
   empty input, local `x` exists (worktrees: main only),
   `addFailStderr: "fatal: a branch named 'x' already exists"`, confirm script
   empty. Assert: second add call is `["worktree", "add", <path>, "x"]`
   (no `-b`), execve happened with `--cwd <path>`, display contains the note.
   An empty confirm script proves no prompt was shown (a prompt would return
   `false` and abort).
2. **Prompted recover (explicit name), accept.** `/worktree --new feat`,
   `addFailStderr` with `feat`, `confirms: [true]`. Assert retry call
   `["worktree", "add", <path>, "feat"]` and relaunch.
3. **Prompted recover, decline.** Same but `confirms: [false]`. Assert no
   second add call, no execve, display contains `a branch named 'feat' already
   exists`.
4. **Unrelated failure → no prompt.** `addFailStderr: "fatal: unable to
   access 'https://…'"` with `/worktree --new feat`, empty confirm script.
   Assert exactly one add call, no execve, error displayed. (An empty confirm
   script returning `false` proves the prompt was never shown, since a prompt
   would have aborted before the second call.)

## Docs

- `README.md`, "Checks" section: add a **Branch name collision** bullet
  describing the prompted recovery for typed names and the automatic recovery
  for auto-defaulted names.
- `README.md`, interactive "Empty" bullet: note that when the auto-defaulted
  local name already exists, it is checked out directly.
- `CONTEXT.md`, resolved decisions: add D11 — branch-name collision recovers by
  checking out the existing branch at the same path; prompted for explicit
  names, automatic for auto-defaulted names; safe because of the
  single-checkout rule + fast path.

## Out of scope

- Changing the D3 fast-path confirm (switch into an existing worktree).
- Offering to pick a different new-branch name after a declined prompt.
- `--force` behaviors.
