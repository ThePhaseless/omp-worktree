import { existsSync } from "node:fs";
import * as path from "node:path";
import { shortRef } from "./paths";

/** Shape of `pi.exec`'s `ExecResult` minus `killed`. */
export type GitExec = (cmd: string, args: string[], cwd: string) => Promise<{
	stdout: string;
	stderr: string;
	code: number;
}>;

/**
 * Resolve the Main repo root from either the Main repo or a linked worktree.
 * `git rev-parse --git-common-dir` points at the Main repo's `.git` from both
 * (D4). Throws `Not a git repository: …` on failure.
 */
export async function resolveMainRepoRoot(cwd: string, run: GitExec): Promise<string> {
	const r = await run("git", ["rev-parse", "--git-common-dir"], cwd);
	if (r.code !== 0) throw new Error(`Not a git repository: ${cwd}`);
	const commonDir = path.resolve(cwd, r.stdout.trim());
	if (path.basename(commonDir) === ".git") return path.dirname(commonDir);
	// Common dir is not a bare `.git` (e.g. bare repo layout); best-effort toplevel.
	const top = await run("git", ["rev-parse", "--show-toplevel"], path.dirname(commonDir));
	if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();
	return commonDir;
}

/** Current branch name, or `undefined` when HEAD is detached. */
export async function currentBranch(cwd: string, run: GitExec): Promise<string | undefined> {
	const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (r.code !== 0) return undefined;
	const name = r.stdout.trim();
	return name === "HEAD" ? undefined : name;
}

/** Local and remote branch lists (short names), dropping the remote HEAD refs. */
export async function listBranches(cwd: string, run: GitExec): Promise<{ local: string[]; remote: string[] }> {
	const localR = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], cwd);
	const remoteR = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/"], cwd);
	const local = localR.code === 0 ? localR.stdout.split("\n").map(s => s.trim()).filter(Boolean) : [];
	const remote = remoteR.code === 0
		? remoteR.stdout.split("\n").map(s => s.trim()).filter(s => s && !s.endsWith("/HEAD"))
		: [];
	return { local, remote };
}

export interface WorktreeInfo {
	path: string;
	branch?: string;
	detached?: boolean;
}

/** Parse `git worktree list --porcelain` into worktree records (includes Main). */
export async function listWorktrees(cwd: string, run: GitExec): Promise<WorktreeInfo[]> {
	const r = await run("git", ["worktree", "list", "--porcelain"], cwd);
	if (r.code !== 0) return [];
	const lines = r.stdout.split("\n");
	const wts: WorktreeInfo[] = [];
	let current: WorktreeInfo | null = null;
	for (const line of lines) {
		if (line.startsWith("worktree ")) {
			if (current) wts.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch ".length);
		} else if (line === "detached" && current) {
			current.detached = true;
		}
	}
	if (current) wts.push(current);
	return wts;
}

/** Raw `git status --porcelain` stdout (for the dirty-repo check, D7). */
export async function statusPorcelain(cwd: string, run: GitExec): Promise<string> {
	const r = await run("git", ["status", "--porcelain"], cwd);
	return r.code === 0 ? r.stdout : "";
}

export interface AddWorktreeOpts {
	path: string;
	branch?: string;
	newBranch?: string;
	baseRef?: string;
	/** Create a detached-HEAD worktree at `ref` (or HEAD when omitted). */
	detach?: boolean;
	ref?: string;
}

/**
 * Create a worktree. Modes:
 * - new/tracking branch: `worktree add -b <newBranch> <path> [<baseRef>]`
 * - existing branch: `worktree add <path> <branch>`
 * - detached HEAD: `worktree add --detach <path> [<ref>]`
 * Throws on non-zero exit.
 */
export async function addWorktree(cwd: string, run: GitExec, opts: AddWorktreeOpts): Promise<void> {
	let args: string[];
	if (opts.newBranch) {
		args = ["worktree", "add", "-b", opts.newBranch, opts.path];
		if (opts.baseRef) args.push(opts.baseRef);
	} else if (opts.branch) {
		args = ["worktree", "add", opts.path, opts.branch];
	} else if (opts.detach) {
		args = ["worktree", "add", "--detach", opts.path];
		if (opts.ref) args.push(opts.ref);
	} else {
		throw new Error("addWorktree requires a branch, newBranch, or detach");
	}
	const r = await run("git", args, cwd);
	if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
}

/**
 * Remove a worktree by path or by branch name (resolved via `listWorktrees`).
 * Throws on non-zero exit.
 */
export async function removeWorktree(
	cwd: string,
	run: GitExec,
	target: string,
	force?: boolean,
): Promise<void> {
	let worktreePath = target;
	if (!existsSync(target)) {
		const wts = await listWorktrees(cwd, run);
		const match = wts.find(w => w.branch && shortRef(w.branch) === target);
		if (!match) throw new Error(`No worktree found for ${target}`);
		worktreePath = match.path;
	}
	const args = ["worktree", "remove", worktreePath];
	if (force) args.push("--force");
	const r = await run("git", args, cwd);
	if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree remove failed");
}

/** Markdown lines `- <branch|detached> → <path>`, marking the Main worktree. */
export function formatWorktreeList(wts: WorktreeInfo[]): string {
	if (wts.length === 0) return "_No worktrees._";
	return wts
		.map((w, i) => {
			const label = w.detached ? "detached" : w.branch ? shortRef(w.branch) : path.basename(w.path);
			const tag = i === 0 ? " (main)" : "";
			return `- ${label}${tag} → ${w.path}`;
		})
		.join("\n");
}
