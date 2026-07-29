import * as path from "node:path";
import type { GitExec } from "./git";
import {
	addWorktree,
	currentBranch,
	formatWorktreeList,
	listBranches,
	listWorktrees,
	removeWorktree,
	resolveMainRepoRoot,
	statusPorcelain,
} from "./git";
import {
	buildRelaunchArgs,
	computeDefaultWorktreePath,
	localNameForRemote,
	shortRef,
} from "./paths";
import { parseWorktreeArgs } from "./args";
import { relaunchOmp } from "./relaunch";

export interface WorktreeUI {
	select(
		title: string,
		options: Array<string | { label: string; description?: string }>,
	): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface WorktreeDeps {
	run: GitExec;
	ui: WorktreeUI;
	display: (text: string) => void;
	execve: (exe: string, argv: string[], env: object) => void;
	exit: (code: number) => void;
	stdin: { isTTY?: boolean; setRawMode?(mode: boolean): void } | null;
	processArgv: string[];
	existsSync: (p: string) => boolean;
	/** Glyph resolver keyed by omp's SymbolKey (theme-aware: unicode/nerd/ascii). */
	symbols: (key: string) => string;
}

type Mode = { kind: "checkout"; branch: string } | { kind: "new"; name: string; baseRef?: string };

/**
 * Orchestrates the `/worktree` command. Fully injectable for testing; only the
 * read-only `getSessionDir()` / `getSessionFile()` are used so the session stays
 * in the Main bucket (D1).
 */
export async function runWorktreeCommand(
	input: string,
	ctx: { cwd: string; sessionManager: { getSessionDir(): string; getSessionFile(): string | undefined } },
	deps: WorktreeDeps,
): Promise<void> {
	const action = parseWorktreeArgs(input);
	const cwd = ctx.cwd;

	if (action.kind === "list") {
		deps.display(formatWorktreeList(await listWorktrees(cwd, deps.run), deps.symbols));
		return;
	}

	if (action.kind === "remove") {
		if (!(await deps.ui.confirm("Remove worktree", `Remove ${action.target}?`))) return;
		try {
			await removeWorktree(cwd, deps.run, action.target, action.force);
		} catch (e) {
			deps.display(`${deps.symbols("status.warning")} ${(e as Error).message}`);
			return;
		}
		deps.ui.notify(`Removed ${action.target}`, "info");
		return;
	}

	// create/switch
	let mainRoot: string;
	try {
		mainRoot = await resolveMainRepoRoot(cwd, deps.run);
	} catch (e) {
		deps.display(`${deps.symbols("status.warning")} ${(e as Error).message}`);
		return;
	}

	// Resolve { branch, mode, at0 }.
	let branch: string;
	let mode: Mode;
	let at0: string;
	if (action.kind === "interactive") {
		const cur = await currentBranch(mainRoot, deps.run);
		const { local, remote } = await listBranches(mainRoot, deps.run);
		const options: Array<string | { label: string; description?: string }> = [
			...local.map(b => ({ label: b, description: b === cur ? "current" : "local" })),
			...remote.map(r => ({ label: r, description: "remote" })),
		];
		// Loop: pick a branch → input. Esc on input goes back to the picker.
		// Empty input = checkout the picked branch as-is.
		// Non-empty input = new branch named after the input, based off the pick.
		let choice: string | undefined;
		let name: string | undefined;
		for (;;) {
			choice = await deps.ui.select("Worktree from branch", options);
			if (!choice) return;
			name = await deps.ui.input(`Branch name (empty = checkout ${choice}, esc = back)`);
			if (name !== undefined) break;
		}
		if (name) {
			mode = { kind: "new", name, baseRef: choice };
			branch = name;
		} else if (local.includes(choice)) {
			mode = { kind: "checkout", branch: choice };
			branch = choice;
		} else {
			// Remote → local tracking branch (auto-defaulted name, no prompt).
			mode = { kind: "new", name: localNameForRemote(choice), baseRef: choice };
			branch = mode.name;
		}
		at0 = computeDefaultWorktreePath(mainRoot, branch);
	} else if (action.kind === "checkout") {
		mode = { kind: "checkout", branch: action.branch };
		branch = action.branch;
		at0 = action.at ?? computeDefaultWorktreePath(mainRoot, branch);
	} else {
		// action.kind === "new"
		mode = { kind: "new", name: action.name, baseRef: action.base };
		branch = action.name;
		at0 = action.at ?? computeDefaultWorktreePath(mainRoot, branch);
	}

	// Dirty-repo check (D7).
	const porcelain = await statusPorcelain(mainRoot, deps.run);
	if (porcelain.trim()) {
		const n = porcelain.trim().split("\n").length;
		if (
			!(await deps.ui.confirm(
				"Uncommitted changes",
				`Main repo has ${n} changed/untracked file(s); they won't exist in the worktree. Continue?`,
			))
		)
			return;
	}

	// Existing-worktree fast path: if the branch is already checked out in a
	// worktree, switch into it. If that worktree is the current cwd, warn instead.
	const wts = await listWorktrees(mainRoot, deps.run);
	const existing = wts.find(w => w.branch && shortRef(w.branch) === branch);
	if (existing) {
		if (path.resolve(existing.path) === path.resolve(cwd)) {
			deps.display(`${deps.symbols("status.warning")} Already in ${existing.path} — ${branch} is checked out here. Pick a different branch or use /worktree --new.`);
			return;
		}
		if (await deps.ui.confirm("Worktree exists", `Switch into existing worktree at ${existing.path}?`)) {
			relaunchInto(existing.path);
			return;
		}
		return;
	}

	// Path-collision preflight (D9).
	let at = at0;
	if (deps.existsSync(at) && !wts.some(w => path.resolve(w.path) === path.resolve(at))) {
		const alt = await deps.ui.input("Path exists. Alternative path?", `${at}-2`);
		if (!alt) return;
		if (deps.existsSync(alt)) {
			deps.display(`${deps.symbols("status.warning")} ${alt} also exists`);
			return;
		}
		at = alt;
	}
	try {
		if (mode.kind === "new") {
			await addWorktree(mainRoot, deps.run, { path: at, newBranch: mode.name, baseRef: mode.baseRef });
		} else {
			await addWorktree(mainRoot, deps.run, { path: at, branch: mode.branch });
		}
	} catch (e) {
		deps.display(`${deps.symbols("status.warning")} ${(e as Error).message}`);
		return;
	}
	relaunchInto(at);

	function relaunchInto(worktreePath: string): void {
		const sessionDir = ctx.sessionManager.getSessionDir();
		let sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile && !deps.existsSync(sessionFile)) sessionFile = undefined;
		const flags = buildRelaunchArgs({ cwd: worktreePath, sessionDir, sessionFile });
		deps.ui.notify(`Switching to ${worktreePath}…`, "info");
		relaunchOmp(flags, {
			execve: deps.execve,
			exit: deps.exit,
			stdin: deps.stdin,
			processArgv: deps.processArgv,
			env: { ...process.env },
			display: deps.display,
		});
	}
}
