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
- **`--force` caveat (verified empirically).** `git worktree add -f` *does*
  allow the same branch in two worktrees. The plugin never passes `--force`, so
  the guarantee holds for every call this code makes.
- **No leftover directory (verified empirically).** `git worktree add -b` dies
  on the branch-name validation before creating the worktree directory, so
  retrying the same path needs no re-run of the D9 path-collision preflight.
- Fatal format is exactly `fatal: a branch named '<name>' already exists`
  (straight quotes, name verbatim; exit 255). `addWorktree` throws
  `new Error(stderr.trim())`, so the catch block sees the fatal line as the
  message.

## Behavior

The recovery decision is keyed on **how the branch name was entered**, not on
the pick source. A picked branch accepted with **empty input** means "use it
as-is" — intent is unambiguous, so no confirmation is shown. A **custom typed
name** (or any CLI form) expresses intent that may contradict reality
(create-new colliding with exists), so those paths prompt.

When `addWorktree` fails in `new` mode and the message matches
`/^fatal: a branch named '(.+)' already exists$/` with the captured name equal
to `mode.name`, recover by retrying `git worktree add <path> <name>` (plain
checkout, no `-b`) at the same path, then `relaunchInto(path)`:

| How the name was entered | Behavior |
|---|---|
| Empty input (interactive; only reachable via remote pick, D8 auto-name) | **Auto-recover, no prompt**: display *"Branch `<name>` already exists locally — checking it out"*, retry plain checkout, relaunch. |
| Custom typed name (interactive), or `/worktree --new <name>` | Prompt: *"Branch `<name>` already exists — check it out in the new worktree instead?"*. **Accept** → retry plain checkout + relaunch. **Decline** → display the original git error and return. |

The existing-worktree fast path (D3) gets the same discriminator. When the
resolved branch is already checked out in another worktree:

| How the branch was entered | Behavior |
|---|---|
| Empty input (interactive, local or remote pick) | **Auto-switch, no prompt**: display *"Branch `<branch>` is already checked out at `<path>` — switching"*, relaunch into that worktree. |
| Custom typed name, or CLI `/worktree <branch>` | Confirm *"Switch into existing worktree at `<path>`?"* (unchanged). |

Unchanged, deliberately:

- Non-collision `addWorktree` failures keep the current behavior (display
  error, return) — never prompt.
- If the recovery checkout itself fails (rare race, e.g. the branch was checked
  out elsewhere mid-flight), display that error and return; no second prompt.
- The "Already in `<path>` — branch is checked out here" warning (D3) stays a
  warning.
- D7 dirty-repo and D9 path-collision prompts are untouched — they are not
  branch-existence decisions.

## Branch picker sort

The interactive branch picker lists options in a fixed priority order, not
refname order:

1. **Current branch** (main repo HEAD, `currentBranch`).
2. **Remote versions of the current branch** — every remote ref whose local
   name equals the current branch (`origin/feature`, `upstream/feature`).
3. **Primary branch** — resolved via `git symbolic-ref refs/remotes/origin/HEAD`
   (short name of the default branch), falling back to `main`, then `master`,
   whichever exists in the local or remote lists; `undefined` if none.
4. **Remote versions of the primary branch** (same matching as 2).
5. **Default order** — remaining local branches in refname order, then
   remaining remote refs in refname order (unchanged).

Dedup rules: a label appears once. When the current branch *is* the primary
branch, slots 3–4 are skipped (slots 1–2 already cover them). When the current
branch or primary is absent from the lists (detached HEAD, fresh clone with no
local `main`), its slots are skipped. Sorting applies only to the interactive
picker, not to `/worktree list` (a worktree display, not a branch list).

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

Add the primary-branch resolver (origin/HEAD, fallback `main` → `master`):

```ts
/**
 * The repo's primary (default) branch: `git symbolic-ref
 * refs/remotes/origin/HEAD` short name when it exists in the local/remote
 * lists, else `main`, else `master`; undefined when none match.
 */
export async function primaryBranch(
	cwd: string,
	run: GitExec,
	local: string[],
	remote: string[],
): Promise<string | undefined> {
	const r = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (r.code === 0) {
		const name = r.stdout.trim().replace(/^refs\/remotes\/[^/]+\//, "");
		if (local.includes(name) || remote.some(x => localNameForRemote(x) === name)) return name;
	}
	for (const cand of ["main", "master"]) {
		if (local.includes(cand) || remote.some(x => localNameForRemote(x) === cand)) return cand;
	}
	return undefined;
}
```

### `src/paths.ts`

Add the pure picker-order helper:

```ts
/**
 * Interactive picker order (D12): current branch, remote versions of it,
 * primary branch, remote versions of it, then remaining locals and remotes in
 * refname order. Labels are unique.
 */
export function sortBranchesForPicker(opts: {
	local: string[];
	remote: string[];
	current?: string;
	primary?: string;
}): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (b: string) => {
		if (!seen.has(b)) {
			seen.add(b);
			out.push(b);
		}
	};
	const remotesOf = (b: string) => opts.remote.filter(r => localNameForRemote(r) === b);
	if (opts.current) {
		add(opts.current);
		remotesOf(opts.current).forEach(add);
	}
	if (opts.primary && opts.primary !== opts.current) {
		add(opts.primary);
		remotesOf(opts.primary).forEach(add);
	}
	opts.local.filter(b => !seen.has(b)).forEach(add);
	opts.remote.filter(r => !seen.has(r)).forEach(add);
	return out;
}
```

### `src/command.ts`

1. Interactive flow: after `listBranches`, resolve the primary branch, sort the
   picker options, and keep the existing descriptions (`current` / `local` /
   `remote` by list membership):

```ts
const { local, remote } = await listBranches(mainRoot, deps.run);
const primary = await primaryBranch(mainRoot, deps.run, local, remote);
const ordered = sortBranchesForPicker({ local, remote, current: cur, primary });
const options = ordered.map(b => ({
	label: b,
	description: b === cur ? "current" : local.includes(b) ? "local" : "remote",
}));
```

2. Extend `Mode` so recovery can distinguish empty-input from explicit names:

```ts
type Mode =
	| { kind: "checkout"; branch: string; auto?: boolean }
	| { kind: "new"; name: string; baseRef?: string; auto?: boolean };
```

   `auto: true` means "reached with empty input (use-as-is)": set in the
   interactive flow for the local-pick checkout branch and the remote-pick
   auto-name branch. Typed names, `/worktree <branch>`, and `/worktree --new`
   leave it unset.

3. Fast path: gate the existing switch confirm on `mode.auto`:

```ts
if (existing) {
	if (deps.realpathSync(existing.path) === deps.realpathSync(cwd)) {
		deps.display(/* "Already in …" warning, unchanged */);
		return;
	}
	if (mode.auto) {
		deps.display(`${deps.symbols("status.warning")} Branch ${branch} is already checked out at ${existing.path} — switching`);
		relaunchInto(existing.path);
		return;
	}
	if (await deps.ui.confirm("Worktree exists", `Switch into existing worktree at ${existing.path}?`)) {
		relaunchInto(existing.path);
		return;
	}
	return;
}
```

4. Replace the `addWorktree` catch block with:

```ts
} catch (e) {
	const msg = (e as Error).message;
	if (mode.kind === "new" && branchExistsInAddError(msg) === mode.name) {
		if (mode.auto) {
			deps.display(`${deps.symbols("status.warning")} Branch ${mode.name} already exists locally — checking it out`);
		} else if (
			!(await deps.ui.confirm("Branch exists", `Branch ${mode.name} already exists — check it out in the new worktree instead?`))
		) {
			deps.display(`${deps.symbols("status.warning")} ${msg}`);
			return;
		}
		try {
			await addWorktree(mainRoot, deps.run, { path: at, branch: mode.name });
		} catch (e2) {
			deps.display(`${deps.symbols("status.warning")} ${(e2 as Error).message}`);
			return;
		}
		relaunchInto(at);
		return;
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

New/changed tests:

1. **Auto-recover `-b` (remote pick, empty input).** Select `origin/x`, empty
   input, local `x` exists (worktrees: main only),
   `addFailStderr: "fatal: a branch named 'x' already exists"`, **empty** confirm
   script. Assert: second add call is `["worktree", "add", <path>, "x"]` (no
   `-b`), execve with `--cwd <path>`, display contains the note. The empty
   confirm script proves no prompt was shown (a prompt would return `false`
   and abort).
2. **Prompted recover (typed name), accept.** `/worktree --new feat`,
   `addFailStderr` with `feat`, `confirms: [true]`. Assert retry call
   `["worktree", "add", <path>, "feat"]` and relaunch.
3. **Prompted recover, decline.** Same but `confirms: [false]`. Assert no
   second add call, no execve, display contains `a branch named 'feat' already
   exists`.
4. **Unrelated failure → no prompt.** `addFailStderr: "fatal: unable to access
   'https://…'"` with `/worktree --new feat`, empty confirm script. Assert
   exactly one add call, no execve, error displayed.
5. **Auto-switch fast path (local pick, empty input) — CHANGED test.** Pick
   `feature` (already checked out at `sibling("feature")`), empty input,
   **empty** confirm script. Assert execve relaunches into
   `sibling("feature")`, no confirm consumed. (Replaces the current
   "interactive pick current → empty input → switch to existing worktree"
   test, which passes `confirms: [true]`.)
6. **Fast path still prompts for typed names / CLI.** New test: interactive
   typed name that is checked out elsewhere, `confirms: [false]` → no execve.
   Existing CLI test "existing worktree + accept → relaunch" keeps
   `confirms: [true]`.

**Sort tests.**

- `test/paths.test.ts` (pure helper): current first; remotes-of-current second
  (multi-remote, slashed names via `localNameForRemote`); primary third;
  remotes-of-primary fourth; remainder in refname order, locals before remotes;
  dedup when `current === primary` (single `origin/main`); detached HEAD
  (no current); no primary; primary absent from lists (slot skipped).
- `test/git.test.ts` (following its existing harness): `primaryBranch` resolves
  origin/HEAD; origin/HEAD pointing at a name absent from both lists falls back
  to `main`; `main` absent falls back to `master`; nothing → `undefined`.
- `test/command.test.ts`: extend `makeUi` to record `select` calls
  (title + options), and assert the interactive flow passes sorted options —
  first option is the current branch, followed by its remotes, then the
  primary, then its remotes. Existing tests are unaffected (their `selects`
  reference labels, and ordering within the shift-based script stays valid).

## Docs

- `README.md`, "Checks" section: add a **Branch name collision** bullet
  describing the prompted recovery for typed names and the automatic recovery
  for empty-input picks.
- `README.md`, interactive section: note the picker order (current branch →
  its remotes → primary branch → its remotes → rest) and that an
  already-existing branch (local or remote pick) is used directly — collisions
  with existing worktrees switch automatically, and auto-defaulted names that
  exist locally are checked out directly.
- `CONTEXT.md`: amend D3 (empty-input switches into the existing worktree
  without a confirm) and add D11 — branch-name collision recovers by checking
  out the existing branch at the same path; prompted for explicit names,
  automatic for empty-input picks; safe because of the single-checkout rule +
  fast path. Add D12 — picker sort order (current → remotes of current →
  primary → remotes of primary → refname order; primary = origin/HEAD default,
  fallback `main` → `master`).

## Out of scope

- Offering to pick a different new-branch name after a declined prompt.
- `--force` behaviors.
- Changing the D7 / D9 prompts.
