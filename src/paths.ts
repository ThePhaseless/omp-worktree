import * as path from "node:path";

/**
 * Replace any character outside [A-Za-z0-9._-] with `-`, collapse repeats, and
 * strip leading/trailing `-`. `feature/foo` → `feature-foo`.
 */
export function sanitizeBranchName(branch: string): string {
	let out = branch.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-");
	out = out.replace(/^-+/, "").replace(/-+$/, "");
	return out;
}

/**
 * Default worktree location: a sibling of the Main repo, named
 * `<repo>-wt-<sanitized-branch>` (D3 sibling location).
 */
export function computeDefaultWorktreePath(repoRoot: string, branch: string): string {
	return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-wt-${sanitizeBranchName(branch)}`);
}

/**
 * Strip the leading remote namespace: `origin/x` → `x` (text after the first
 * `/`; if no `/`, return as-is). Used for the default local tracking-branch
 * name (D8).
 */
export function localNameForRemote(remote: string): string {
	const slash = remote.indexOf("/");
	return slash >= 0 ? remote.slice(slash + 1) : remote;
}

/**
 * Strip a `refs/heads/` (or `refs/remotes/`) prefix for worktree-list branch
 * comparison. The porcelain output uses `branch refs/heads/foo`.
 */
export function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, "");
}

/**
 * Build the omp CLI flags that move into a worktree while keeping the session in
 * the Main bucket. `--fork <sessionFile>` is only appended when a session file
 * is supplied (D1 fork, D6).
 */
export function buildRelaunchArgs(opts: { cwd: string; sessionDir: string; sessionFile?: string }): string[] {
	const flags = ["--cwd", opts.cwd, "--session-dir", opts.sessionDir];
	if (opts.sessionFile) flags.push("--fork", opts.sessionFile);
	return flags;
}

/**
 * Compose the argv for `process.execve`. omp runs in script mode here
 * (`process.argv = [<bun>, <…/dist/cli.js>, …]`), so the script slot is
 * preserved; in compiled-binary mode it is dropped (D6).
 */
export function buildExecveArgv(
	processArgv: string[],
	newArgs: string[],
): { exe: string; argv: string[] } {
	const exe = process.execPath;
	const script = processArgv[1];
	const isScript = !!script && /\.(c?js|mjs|ts)$/i.test(script);
	const argv = isScript ? [script, ...newArgs] : [...newArgs];
	return { exe, argv };
}
