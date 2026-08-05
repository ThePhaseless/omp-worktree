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

Creating a worktree is fully automatic: when no worktree checks out the
requested branch, the plugin creates one and relaunches into it — whether the
branch exists locally or not. A branch that exists locally is checked out
directly (`git worktree add <path> <branch>`); a branch that does not exist is
created from the base (`-b <branch> <path> [<base>]`). No confirmation is shown
for either.

When `addWorktree` fails in `new` mode and the message matches
`/^fatal: a branch named '(.+)' already exists$/` with the captured name equal
to `mode.name`, the failure is swallowed and retried automatically: display
*"Branch `<name>` already exists locally — checking it out"*, retry
`git worktree add <path> <name>` (plain checkout, no `-b`) at the same path,
then `relaunchInto(path)`. No prompt — this is the same "no worktree exists →
auto-create" rule applied to an existing local branch.

The only prompt for an existing branch is the D3 switch: when the resolved
branch is already checked out in another worktree, the plugin always asks
*"Switch into existing worktree at `<path>`?"* — regardless of how the branch
was entered (empty input, typed name, or CLI). The "Already in `<path>` —
branch is checked out here" warning (D3) is unchanged.

Unchanged, deliberately:

- Non-collision `addWorktree` failures keep the current behavior (display
  error, return) — never prompt.
- If the recovery checkout itself fails (rare race, e.g. the branch was checked
  out elsewhere mid-flight), display that error and return; no second prompt.
- The "Already in `<path>` — branch is checked out here" warning (D3) stays a
  warning.
- The fast-path "Switch into existing worktree" confirm (D3) — always prompts,
  including empty-input picks.
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

2. Replace the `addWorktree` catch block with:

```ts
} catch (e) {
	const msg = (e as Error).message;
	if (mode.kind === "new" && branchExistsInAddError(msg) === mode.name) {
		deps.display(`${deps.symbols("status.warning")} Branch ${mode.name} already exists locally — checking it out`);
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

The `Mode` type, the D3 fast path, and the interactive remote-pick branch are
unchanged; no new state is introduced.

## Testing

Extend the `test/command.test.ts` harness: add `addFailStderr?: string` to
`RunOpts` — the *first* `worktree add` call fails with that stderr, subsequent
calls succeed (a counter inside `makeRun`). Keep `addFails` for always-fail
cases.

New tests (all with **empty** confirm scripts — a prompt would return `false`
and abort before the retry/execve, so a passing test proves no prompt was
shown):

1. **`--new` collision auto-recovers.** `/worktree --new feat`,
   `addFailStderr: "fatal: a branch named 'feat' already exists"`, empty
   confirm script. Assert: first add `["worktree", "add", "-b", "feat",
   <path>]`, second add `["worktree", "add", <path>, "feat"]` (no `-b`),
   execve with `--cwd <path>`, display contains "already exists locally".
2. **Remote-pick collision auto-recovers.** Select `origin/x`, empty input,
   local `x` exists, `addFailStderr` with `x`. Assert second add
   `["worktree", "add", <path>, "x"]`, execve, note displayed.
3. **Unrelated failure → no recovery.** `addFailStderr: "fatal: unable to
   access 'https://…'"` with `/worktree --new feat`, empty confirm script.
   Assert exactly one add call, no execve, error displayed.
4. **Fast path unchanged.** Existing tests keep their confirm scripts:
   "interactive pick current → empty input → switch to existing worktree"
   (`confirms: [true]`, execve into `sibling("feature")`) and "existing
   worktree + accept → relaunch" (CLI, `confirms: [true]`). No new fast-path
   tests.

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

- `README.md`, "Checks" section: add a **Branch name collision** bullet —
  if a new branch name already exists locally, the existing branch is checked
  out in the new worktree automatically (no prompt).
- `README.md`, interactive section: note the picker order (current branch →
  its remotes → primary branch → its remotes → rest) and that picking a
  branch always creates a worktree for it (or checks out the existing local
  branch of that name); only when a worktree already checks out the branch
  does the plugin ask before switching (D3).
- `CONTEXT.md`: add D11 — worktree creation is automatic: if no worktree
  checks out the requested branch, the plugin creates one (plain checkout
  when the branch exists locally, `-b` otherwise); a `-b` branch-name
  collision is retried as a plain checkout without prompting. The only prompt
  for an existing branch is the D3 switch into its worktree. Add D12 —
  picker sort order (current → remotes of current → primary → remotes of
  primary → refname order; primary = origin/HEAD default, fallback `main` →
  `master`).

## Out of scope

- Offering to pick a different new-branch name after a declined prompt.
- `--force` behaviors.
- Changing the D7 / D9 prompts.
