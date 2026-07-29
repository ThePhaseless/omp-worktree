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
}

type Mode = { kind: "checkout"; branch: string } | { kind: "new"; name: string; baseRef?: string };

const NEW_BRANCH_LABEL = "➕ New branch…";

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
		deps.display(formatWorktreeList(await listWorktrees(cwd, deps.run)));
		return;
	}

	if (action.kind === "remove") {
		if (!(await deps.ui.confirm("Remove worktree", `Remove ${action.target}?`))) return;
		try {
			await removeWorktree(cwd, deps.run, action.target, action.force);
		} catch (e) {
			deps.display(`⚠️ ${(e as Error).message}`);
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
		deps.display(`⚠️ ${(e as Error).message}`);
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
			...local.map(b => ({ label: b, description: b === cur ? "current (will branch off)" : "local" })),
			...remote.map(r => ({ label: r, description: "remote" })),
			{ label: NEW_BRANCH_LABEL },
		];
		const choice = await deps.ui.select("Worktree from branch", options);
		if (!choice) return;

		if (choice === NEW_BRANCH_LABEL) {
			const name = await deps.ui.input("New branch name");
			if (!name) return;
			const baseLabel = await deps.ui.select(
				"Base branch",
				[...local, ...remote, "(current HEAD)"].map(x => ({ label: x })),
			);
			if (!baseLabel) return;
			mode = { kind: "new", name, baseRef: baseLabel === "(current HEAD)" ? undefined : baseLabel };
			branch = name;
		} else if (local.includes(choice)) {
			if (choice === cur) {
				// Current branch is single-checkout → redirect to new-branch flow (D3).
				const name = await deps.ui.input("New branch name (from current)", `${choice}-wt`);
				if (!name) return;
				mode = { kind: "new", name, baseRef: choice };
				branch = name;
			} else {
				mode = { kind: "checkout", branch: choice };
				branch = choice;
			}
		} else {
			// Remote → local tracking branch, no detached HEAD (D8).
			const name = await deps.ui.input(`Local branch name for ${choice}`, localNameForRemote(choice));
			if (!name) return;
			mode = { kind: "new", name, baseRef: choice };
			branch = name;
		}
		at0 = computeDefaultWorktreePath(mainRoot, branch);
	} else if (action.kind === "checkout") {
		const cur = await currentBranch(mainRoot, deps.run);
		if (action.branch === cur) {
			// Current-branch redirect (D3).
			const name = await deps.ui.input("New branch name", `${action.branch}-wt`);
			if (!name) return;
			mode = { kind: "new", name, baseRef: action.branch };
			branch = name;
		} else {
			mode = { kind: "checkout", branch: action.branch };
			branch = action.branch;
		}
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

	// Existing-worktree fast path.
	const wts = await listWorktrees(mainRoot, deps.run);
	const existing = wts.find(
		w => path.resolve(w.path) === path.resolve(at0) || (w.branch && shortRef(w.branch) === branch),
	);
	if (existing && (await deps.ui.confirm("Worktree exists", `Switch into existing worktree at ${existing.path}?`))) {
		relaunchInto(existing.path);
		return;
	}

	// Path-collision preflight (D9).
	let at = at0;
	if (deps.existsSync(at) && !wts.some(w => path.resolve(w.path) === path.resolve(at))) {
		const alt = await deps.ui.input("Path exists. Alternative path?", `${at}-2`);
		if (!alt) return;
		if (deps.existsSync(alt)) {
			deps.display(`⚠️ ${alt} also exists`);
			return;
		}
		at = alt;
	}

	// Create.
	try {
		if (mode.kind === "new") {
			await addWorktree(mainRoot, deps.run, { path: at, newBranch: mode.name, baseRef: mode.baseRef });
		} else {
			await addWorktree(mainRoot, deps.run, { path: at, branch: mode.branch });
		}
	} catch (e) {
		deps.display(`⚠️ ${(e as Error).message}`);
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
