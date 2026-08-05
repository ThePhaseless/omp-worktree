# Branch-Exists Recovery & Picker Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `git worktree add -b` fails because the branch already exists, recover by checking out the existing branch at the same path (prompted for explicit names, automatic for empty-input remote picks), and sort the interactive branch picker: current branch → its remotes → primary branch → its remotes → rest.

**Architecture:** Two pure/helper additions (`branchExistsInAddError`, `primaryBranch` in `src/git.ts`; `sortBranchesForPicker` in `src/paths.ts`) plus wiring in `runWorktreeCommand` (`src/command.ts`): a `Mode.auto` flag marks auto-defaulted names so the `-b` catch block can decide prompt-vs-auto, and the interactive flow sorts options before showing the picker. The D3 fast-path switch confirm and D7/D9 prompts are untouched.

**Tech Stack:** TypeScript, bun:test (`bun test`), no new dependencies.

## Global Constraints

- Tests run with `bun test`; individual file: `bun test test/<file>.test.ts`. Repo also has a `package.json` script `test` (`bun test`).
- Indentation is TABS (all existing files use tabs).
- No new dependencies; no changes to `package.json`.
- Error messages surfaced via `deps.display()` with the `status.warning` symbol; the harness `UNICODE_SYMBOLS` map already defines `"status.warning": "⚠"`.
- All strings in `command.ts` use em dashes ("—") where existing messages do; match the existing style exactly.
- Do NOT modify: the D3 fast-path switch confirm, the D7 dirty-repo confirm, the D9 path-collision prompt, `src/args.ts`, `src/relaunch.ts`, `src/index.ts`.
- Spec: `docs/superpowers/specs/2026-08-04-branch-exists-recovery-design.md`.

---

### Task 1: `branchExistsInAddError` helper

**Files:**
- Modify: `src/git.ts` (add helper after `addWorktree`)
- Test: `test/git.test.ts` (new describe block, unit-style — no git needed)

**Interfaces:**
- Consumes: nothing new.
- Produces: `branchExistsInAddError(message: string): string | undefined` — returns the colliding branch name when `message` is exactly `fatal: a branch named '<name>' already exists` (single line), else `undefined`. Used by Task 4.

- [ ] **Step 1: Write the failing tests** — append to `test/git.test.ts` (after the existing import block, add `branchExistsInAddError` to the import list from `"../src/git"`, then append this describe at the end of the file):

```ts
describe("branchExistsInAddError", () => {
	test("returns name for branch-exists fatal", () => {
		expect(branchExistsInAddError("fatal: a branch named 'feat' already exists")).toBe("feat");
	});
	test("handles slashed branch names", () => {
		expect(branchExistsInAddError("fatal: a branch named 'feature/foo' already exists")).toBe("feature/foo");
	});
	test("returns undefined for other errors", () => {
		expect(branchExistsInAddError("fatal: 'feat' is already used by worktree at '/x'")).toBeUndefined();
		expect(branchExistsInAddError("add failed")).toBeUndefined();
		expect(branchExistsInAddError("fatal: a branch named 'feat' already exists\nmore")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/git.test.ts`
Expected: FAIL — `branchExistsInAddError is not a function` / import error.

- [ ] **Step 3: Implement** — in `src/git.ts`, after the `addWorktree` function (before `removeWorktree`):

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

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/git.test.ts`
Expected: PASS (all tests, including the pre-existing integration ones).

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: parse git branch-exists fatal into colliding name"
```

---

### Task 2: `primaryBranch` resolver

**Files:**
- Modify: `src/git.ts` (add `localNameForRemote` import from `./paths`; add `primaryBranch` after `listBranches`)
- Test: `test/git.test.ts` (new describe with real-git setup, mirroring the existing `git integration` describe style)

**Interfaces:**
- Consumes: `GitExec` (`run(cmd, args, cwd)` → `{ stdout, stderr, code }`), `listBranches`, `localNameForRemote` from `./paths` (already exists — strips the first remote namespace: `"origin/x"` → `"x"`).
- Produces: `primaryBranch(cwd: string, run: GitExec, local: string[], remote: string[]): Promise<string | undefined>` — short name of `refs/remotes/origin/HEAD` when its target exists in the lists, else `"main"`, else `"master"`, else `undefined`. Used by Task 5.

- [ ] **Step 1: Write the failing tests** — add `primaryBranch` to the import list from `"../src/git"` in `test/git.test.ts`, then append at the end of the file:

```ts
describe("primaryBranch", () => {
	let repo: string;
	beforeEach(async () => {
		repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wt-primary-"));
		await run("git", ["init", "-q", "-b", "main"], repo);
		await run("git", ["config", "user.email", "t@t"], repo);
		await run("git", ["config", "user.name", "t"], repo);
		await fs.promises.writeFile(path.join(repo, "f"), "a");
		await run("git", ["add", "f"], repo);
		await run("git", ["commit", "-qm", "init"], repo);
	});
	afterEach(async () => {
		await fs.promises.rm(repo, { recursive: true, force: true });
	});

	test("resolves origin/HEAD target when present in lists", async () => {
		await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo);
		const { local, remote } = await listBranches(repo, run);
		expect(await primaryBranch(repo, run, local, remote)).toBe("main");
	});
	test("origin/HEAD target absent from lists → falls back to main", async () => {
		await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], repo);
		const { local, remote } = await listBranches(repo, run);
		expect(await primaryBranch(repo, run, local, remote)).toBe("main");
	});
	test("no origin/HEAD and no main → master", async () => {
		await run("git", ["branch", "-m", "main", "master"], repo);
		const { local, remote } = await listBranches(repo, run);
		expect(await primaryBranch(repo, run, local, remote)).toBe("master");
	});
	test("nothing matches → undefined", async () => {
		await run("git", ["branch", "-m", "main", "other"], repo);
		const { local, remote } = await listBranches(repo, run);
		expect(await primaryBranch(repo, run, local, remote)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/git.test.ts`
Expected: FAIL — `primaryBranch is not a function` / import error.

- [ ] **Step 3: Implement** — in `src/git.ts`:
   1. Change the import from `./paths` to also bring in `localNameForRemote`:

```ts
import { localNameForRemote, shortRef } from "./paths";
```

   2. Add after `listBranches`:

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

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/git.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: resolve primary branch via origin/HEAD, fallback main/master"
```

---

### Task 3: `sortBranchesForPicker` helper

**Files:**
- Modify: `src/paths.ts` (add helper after `shortRef`)
- Test: `test/paths.test.ts` (new describe; add the import)

**Interfaces:**
- Consumes: `localNameForRemote` (same file, already exists).
- Produces: `sortBranchesForPicker(opts: { local: string[]; remote: string[]; current?: string; primary?: string }): string[]` — picker order (D12): current, remotes of current, primary, remotes of primary, remaining locals, remaining remotes; unique labels; input order preserved within each bucket. Used by Task 5.

- [ ] **Step 1: Write the failing tests** — add `sortBranchesForPicker` to the import list from `"../src/paths"` in `test/paths.test.ts`, then append at the end of the file:

```ts
describe("sortBranchesForPicker", () => {
	test("current → its remotes → primary → its remotes → rest", () => {
		expect(
			sortBranchesForPicker({
				local: ["feature", "main", "zlocal"],
				remote: ["origin/main", "origin/feature", "upstream/feature", "origin/other", "origin/zlocal"],
				current: "feature",
				primary: "main",
			}),
		).toEqual([
			"feature",
			"origin/feature",
			"upstream/feature",
			"main",
			"origin/main",
			"zlocal",
			"origin/other",
			"origin/zlocal",
		]);
	});
	test("current === primary collapses slots (no duplicate origin/main)", () => {
		expect(
			sortBranchesForPicker({
				local: ["main", "feature"],
				remote: ["origin/main", "origin/feature"],
				current: "main",
				primary: "main",
			}),
		).toEqual(["main", "origin/main", "feature", "origin/feature"]);
	});
	test("no current (detached) → primary slots first", () => {
		expect(
			sortBranchesForPicker({
				local: ["main", "a"],
				remote: ["origin/main"],
				primary: "main",
			}),
		).toEqual(["main", "origin/main", "a"]);
	});
	test("no primary → current + its remotes first, rest default", () => {
		expect(
			sortBranchesForPicker({
				local: ["feature", "a"],
				remote: ["origin/feature", "origin/b"],
				current: "feature",
			}),
		).toEqual(["feature", "origin/feature", "a", "origin/b"]);
	});
	test("slashed remote names match by local name", () => {
		expect(
			sortBranchesForPicker({
				local: ["foo/bar", "main"],
				remote: ["origin/foo/bar"],
				current: "foo/bar",
				primary: "main",
			}),
		).toEqual(["foo/bar", "origin/foo/bar", "main"]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/paths.test.ts`
Expected: FAIL — `sortBranchesForPicker is not a function` / import error.

- [ ] **Step 3: Implement** — in `src/paths.ts`, after `shortRef`:

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

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/paths.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: sort picker options — current, its remotes, primary, its remotes, rest"
```

---

### Task 4: `-b` collision recovery in `runWorktreeCommand`

**Files:**
- Modify: `src/command.ts` (Mode type; interactive remote-pick branch sets `auto`; the `addWorktree` catch block)
- Modify: `test/command.test.ts` (harness `RunOpts.addFailStderr` + add-call counter; 4 new tests)

**Interfaces:**
- Consumes: `branchExistsInAddError` from Task 1 (`./git` import list gains it).
- Produces: `Mode` = `{ kind: "checkout"; branch: string } | { kind: "new"; name: string; baseRef?: string; auto?: boolean }`. `auto: true` marks auto-defaulted names (remote pick + empty input); gates the recovery prompt. The `-b` recovery: on branch-exists fatal matching `mode.name`, auto mode retries a plain checkout with an info note; explicit mode prompts `"Branch <name> already exists — check it out in the new worktree instead?"` and retries on accept, shows the error on decline; any other failure displays the error as today.

- [ ] **Step 1: Extend the test harness** — in `test/command.test.ts`:
   1. Add to `RunOpts`: `addFailStderr?: string;`
   2. In `makeRun`, add `let addCount = 0;` at the top of the function, and replace the `worktree add` branch:

```ts
		if (args[1] === "add") {
			if (opts.addFailStderr !== undefined) {
				if (addCount++ === 0) return { stdout: "", stderr: opts.addFailStderr, code: 1 };
				return { stdout: "", stderr: "", code: 0 };
			}
			return opts.addFails ? { stdout: "", stderr: "add failed", code: 1 } : { stdout: "", stderr: "", code: 0 };
		}
```

- [ ] **Step 2: Write the failing tests** — append inside the `describe("runWorktreeCommand — create/switch", ...)` block (after the existing "no session file → execve argv has no --fork" test):

```ts
	test("interactive remote pick with existing local name → auto-recover, no confirm", async () => {
		const { ui } = makeUi({ selects: ["origin/x"], inputs: [""] });
		const { deps, calls, getExecved, displayMsgs } = makeDeps(
			{
				current: "main",
				local: ["main", "x"],
				remote: ["origin/x"],
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
				addFailStderr: "fatal: a branch named 'x' already exists",
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		const adds = calls.filter(c => c.args[0] === "worktree" && c.args[1] === "add");
		expect(adds.length).toBe(2);
		expect(adds[0].args).toEqual(["worktree", "add", "-b", "x", sibling("x"), "origin/x"]);
		expect(adds[1].args).toEqual(["worktree", "add", sibling("x"), "x"]);
		expect(getExecved()?.argv).toContain(sibling("x"));
		expect(displayMsgs.some(m => m.includes("already exists locally"))).toBe(true);
	});

	test("--new with existing branch name + accept → check out existing branch", async () => {
		const { ui } = makeUi({ confirms: [true] });
		const { deps, calls, getExecved } = makeDeps(
			{
				current: "main",
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
				addFailStderr: "fatal: a branch named 'feat' already exists",
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("--new feat", makeCtx(SESSION_FILE), deps);
		const adds = calls.filter(c => c.args[0] === "worktree" && c.args[1] === "add");
		expect(adds.length).toBe(2);
		expect(adds[0].args).toEqual(["worktree", "add", "-b", "feat", sibling("feat")]);
		expect(adds[1].args).toEqual(["worktree", "add", sibling("feat"), "feat"]);
		expect(getExecved()?.argv).toContain(sibling("feat"));
	});

	test("--new with existing branch name + decline → error shown, no retry", async () => {
		const { ui } = makeUi({ confirms: [false] });
		const { deps, calls, getExecved, displayMsgs } = makeDeps(
			{
				current: "main",
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
				addFailStderr: "fatal: a branch named 'feat' already exists",
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("--new feat", makeCtx(SESSION_FILE), deps);
		const adds = calls.filter(c => c.args[0] === "worktree" && c.args[1] === "add");
		expect(adds.length).toBe(1);
		expect(getExecved()).toBeNull();
		expect(displayMsgs.some(m => m.includes("a branch named 'feat' already exists"))).toBe(true);
	});

	test("unrelated add failure → no recovery prompt", async () => {
		const { ui } = makeUi({});
		const { deps, calls, getExecved, displayMsgs } = makeDeps(
			{
				current: "main",
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
				addFailStderr: "fatal: unable to access 'https://example.invalid'",
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("--new feat", makeCtx(SESSION_FILE), deps);
		const adds = calls.filter(c => c.args[0] === "worktree" && c.args[1] === "add");
		expect(adds.length).toBe(1);
		expect(getExecved()).toBeNull();
		expect(displayMsgs.some(m => m.includes("unable to access"))).toBe(true);
	});
```

Note: the empty confirm script in the first and last tests is the assertion — if a prompt were shown, the script's `confirm` would return `false` and abort before the second add / execve.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `bun test test/command.test.ts`
Expected: the four new tests FAIL (recovery not implemented); pre-existing tests still PASS.

- [ ] **Step 4: Implement** — in `src/command.ts`:
   1. Add `branchExistsInAddError` to the import from `./git`.
   2. Change the `Mode` type:

```ts
type Mode = { kind: "checkout"; branch: string } | { kind: "new"; name: string; baseRef?: string; auto?: boolean };
```

   3. In the interactive flow, the remote-pick branch becomes:

```ts
		} else {
			// Remote → local tracking branch (auto-defaulted name, no prompt).
			mode = { kind: "new", name: localNameForRemote(choice), baseRef: choice, auto: true };
			branch = mode.name;
		}
```

   4. Replace the `addWorktree` try/catch (keep the `try` body identical):

```ts
	} catch (e) {
		const msg = (e as Error).message;
		if (mode.kind === "new" && branchExistsInAddError(msg) === mode.name) {
			if (!mode.auto) {
				if (
					!(await deps.ui.confirm(
						"Branch exists",
						`Branch ${mode.name} already exists — check it out in the new worktree instead?`,
					))
				) {
					deps.display(`${deps.symbols("status.warning")} ${msg}`);
					return;
				}
			} else {
				deps.display(`${deps.symbols("status.warning")} Branch ${mode.name} already exists locally — checking it out`);
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

- [ ] **Step 5: Run the full command test file**

Run: `bun test test/command.test.ts`
Expected: PASS — all pre-existing tests AND the four new ones.

- [ ] **Step 6: Commit**

```bash
git add src/command.ts test/command.test.ts
git commit -m "feat: recover from branch-exists add failure — prompt or auto checkout"
```

---

### Task 5: Picker sort wiring

**Files:**
- Modify: `src/command.ts` (interactive flow: resolve primary, sort options)
- Modify: `test/command.test.ts` (harness: `RunOpts.originHead` + `symbolic-ref` mock; `makeUi` records select calls; 2 new tests)

**Interfaces:**
- Consumes: `primaryBranch` (Task 2) and `sortBranchesForPicker` (Task 3); `cur` (current branch, already fetched as `const cur = await currentBranch(...)`), `local`/`remote` (already fetched via `listBranches`).
- Produces: sorted `options` array for `deps.ui.select` with descriptions `"current"` / `"local"` / `"remote"`.

- [ ] **Step 1: Extend the harness** — in `test/command.test.ts`:
   1. Add to `RunOpts`: `originHead?: string;`
   2. In `makeRun`, before the final `return { stdout: "", stderr: "", code: 0 };`, add:

```ts
		if (sub === "symbolic-ref") {
			return opts.originHead !== undefined
				? { stdout: opts.originHead, stderr: "", code: 0 }
				: { stdout: "", stderr: "fatal: not a symbolic ref", code: 1 };
		}
```

   3. Change `makeUi` to record select calls (return type gains `selectCalls`):

```ts
function makeUi(script: UiScript): {
	ui: WorktreeUI;
	notifies: string[];
	selectCalls: Array<{ title: string; options: Array<string | { label: string; description?: string }> }>;
} {
	const s = [...(script.selects ?? [])];
	const i = [...(script.inputs ?? [])];
	const c = [...(script.confirms ?? [])];
	const notifies: string[] = [];
	const selectCalls: Array<{ title: string; options: Array<string | { label: string; description?: string }> }> = [];
	const ui: WorktreeUI = {
		select: async (title, options) => {
			selectCalls.push({ title, options });
			return s.shift();
		},
		confirm: async () => c.shift() ?? false,
		input: async () => i.shift(),
		notify: (msg) => notifies.push(msg),
	};
	return { ui, notifies, selectCalls };
}
```

- [ ] **Step 2: Write the failing tests** — append inside the `describe("runWorktreeCommand — create/switch", ...)` block:

```ts
	test("picker options sorted: current → its remotes → primary → its remotes → rest", async () => {
		const { ui, selectCalls } = makeUi({ selects: ["feature"], inputs: [""] });
		const { deps } = makeDeps(
			{
				current: "feature",
				local: ["feature", "main", "zlocal"],
				remote: ["origin/main", "origin/feature", "upstream/feature", "origin/other", "origin/zlocal"],
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		const options = (selectCalls[0]?.options ?? []) as Array<{ label: string; description?: string }>;
		expect(options.map(o => o.label)).toEqual([
			"feature",
			"origin/feature",
			"upstream/feature",
			"main",
			"origin/main",
			"zlocal",
			"origin/other",
			"origin/zlocal",
		]);
		const byLabel = new Map(options.map(o => [o.label, o.description]));
		expect(byLabel.get("feature")).toBe("current");
		expect(byLabel.get("main")).toBe("local");
		expect(byLabel.get("origin/other")).toBe("remote");
	});

	test("picker honors origin/HEAD default branch", async () => {
		const { ui, selectCalls } = makeUi({ selects: ["feature"], inputs: [""] });
		const { deps } = makeDeps(
			{
				current: "feature",
				local: ["feature", "trunk"],
				remote: ["origin/trunk", "origin/feature"],
				worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
				originHead: "refs/remotes/origin/trunk",
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		const options = (selectCalls[0]?.options ?? []) as Array<{ label: string }>;
		expect(options.map(o => o.label)).toEqual(["feature", "origin/feature", "trunk", "origin/trunk"]);
	});
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `bun test test/command.test.ts`
Expected: the two new tests FAIL (options still in unsorted `[...local, ...remote]` order); all pre-existing tests PASS (the shift-based `select` mock is order-independent).

- [ ] **Step 4: Implement** — in `src/command.ts`:
   1. Add `primaryBranch` to the import from `./git`; add `sortBranchesForPicker` to the import from `./paths`.
   2. In the interactive branch of `runWorktreeCommand`, replace:

```ts
		const { local, remote } = await listBranches(mainRoot, deps.run);
		const options: Array<string | { label: string; description?: string }> = [
			...local.map(b => ({ label: b, description: b === cur ? "current" : "local" })),
			...remote.map(r => ({ label: r, description: "remote" })),
		];
```

with:

```ts
		const { local, remote } = await listBranches(mainRoot, deps.run);
		const primary = await primaryBranch(mainRoot, deps.run, local, remote);
		const ordered = sortBranchesForPicker({ local, remote, current: cur, primary });
		const options: Array<string | { label: string; description?: string }> = ordered.map(b => ({
			label: b,
			description: b === cur ? "current" : local.includes(b) ? "local" : "remote",
		}));
```

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — every test file.

- [ ] **Step 6: Commit**

```bash
git add src/command.ts test/command.test.ts
git commit -m "feat: sort interactive picker — current, its remotes, primary, its remotes, rest"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` (interactive section + Checks section)
- Modify: `CONTEXT.md` (resolved decisions: add D11, D12)

**Interfaces:**
- Consumes: the behaviors implemented in Tasks 4 and 5.

- [ ] **Step 1: Update `README.md`**

   1. In the interactive section, after the `- **Esc** — go back to the branch picker.` bullet, add:

```md
Branches are listed in priority order: the current branch, remote versions of
the current branch, the primary branch (`origin/HEAD`, falling back to
`main`/`master`), remote versions of the primary branch, then everything else.
```

   2. In the interactive "Empty" bullet, replace the last sub-bullet:

```md
  - Remote branches create a local tracking branch with an auto-defaulted name
    (`origin/x` → `x`).
```

with:

```md
  - Remote branches create a local tracking branch with an auto-defaulted name
    (`origin/x` → `x`); if that name already exists locally, it is checked out
    directly without prompting.
```

   3. In the "Checks" section, after the "Path collision" bullet, add:

```md
- **Branch name collision** — if a new branch name already exists, you're asked
  to check out the existing branch in the new worktree instead. When the name
  was auto-derived from a remote branch (empty input), the checkout happens
  without prompting.
```

- [ ] **Step 2: Update `CONTEXT.md`** — in the "Resolved decisions (baked into the design)" list, after the D10 bullet, add:

```md
- **D11 — Branch-name collision recovers by checking out the existing branch.**
  If `worktree add -b <name>` fails because the branch already exists, the
  plugin retries as a plain checkout of that branch at the same path.
  Explicitly typed names prompt first; auto-defaulted names (remote pick +
  empty input) recover without prompting. Safe because git enforces
  single-checkout and the existing-worktree fast path already routes
  checked-out branches.

- **D12 — Picker sorts current and primary branches first.** The interactive
  branch picker order: current branch, remote versions of the current branch,
  primary branch (`refs/remotes/origin/HEAD` target, falling back to `main`,
  then `master`), remote versions of the primary branch, then remaining local
  and remote refs in refname order.
```

- [ ] **Step 3: Verify**

Run: `bun test`
Expected: PASS — no code changed, docs only.

- [ ] **Step 4: Commit**

```bash
git add README.md CONTEXT.md
git commit -m "docs: branch-collision recovery, picker order (D11, D12)"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: PASS across all test files (`args`, `command`, `git`, `paths`, `relaunch`).

- [ ] **Step 2: Manual smoke test of the recovery (optional but recommended)**

```bash
tmp=$(mktemp -d) && cd "$tmp" && git init -q -b main r && cd r \
  && git commit -q --allow-empty -m init && git branch feat \
  && git worktree add -q ../w1 feat && cd ../w1 \
  && echo "repo ready; in a real omp session run: /worktree --new feat"
```

Expected: the plugin prompts *"Branch feat already exists — check it out in the new worktree instead?"*; accepting creates the worktree and switches into it; declining shows `fatal: a branch named 'feat' already exists`.

- [ ] **Step 3: Commit any stragglers**

```bash
git status --short
```

Expected: clean working tree.
