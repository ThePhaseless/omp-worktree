import { test, expect, describe } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { GitExec, WorktreeInfo } from "../src/git";
import { runWorktreeCommand, type WorktreeDeps, type WorktreeUI } from "../src/command";

interface RunOpts {
	current?: string;
	local?: string[];
	remote?: string[];
	porcelain?: string;
	worktrees?: WorktreeInfo[];
	notRepo?: boolean;
	addFails?: boolean;
}

function porcelainOutput(wts: WorktreeInfo[]): string {
	const lines: string[] = [];
	for (const w of wts) {
		lines.push(`worktree ${w.path}`);
		lines.push(`HEAD 0000000000000000000000000000000000000000`);
		if (w.detached) lines.push("detached");
		else if (w.branch) lines.push(`branch ${w.branch}`);
	}
	return lines.join("\n") + "\n";
}

function makeRun(opts: RunOpts) {
	const calls: { cmd: string; args: string[]; cwd: string }[] = [];
	const run: GitExec = async (cmd, args, cwd) => {
		calls.push({ cmd, args: [...args], cwd });
		if (cmd !== "git") return { stdout: "", stderr: "", code: 1 };
		const sub = args[0];
		if (sub === "rev-parse") {
			if (args.includes("--git-common-dir"))
				return opts.notRepo
					? { stdout: "", stderr: "not a repo", code: 1 }
					: { stdout: ".git", stderr: "", code: 0 };
			if (args.includes("--abbrev-ref")) return { stdout: opts.current ?? "main", stderr: "", code: 0 };
			if (args.includes("--show-toplevel")) return { stdout: cwd, stderr: "", code: 0 };
		}
		if (sub === "for-each-ref") {
			if (args.includes("refs/heads/")) return { stdout: (opts.local ?? []).join("\n"), stderr: "", code: 0 };
			if (args.includes("refs/remotes/")) return { stdout: (opts.remote ?? []).join("\n"), stderr: "", code: 0 };
		}
		if (sub === "worktree") {
			if (args[1] === "list") return { stdout: porcelainOutput(opts.worktrees ?? []), stderr: "", code: 0 };
			if (args[1] === "add")
				return opts.addFails ? { stdout: "", stderr: "add failed", code: 1 } : { stdout: "", stderr: "", code: 0 };
			if (args[1] === "remove") return { stdout: "", stderr: "", code: 0 };
		}
		if (sub === "status") return { stdout: opts.porcelain ?? "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	return { run, calls };
}

interface UiScript {
	selects?: string[];
	inputs?: string[];
	confirms?: boolean[];
}

function makeUi(script: UiScript): { ui: WorktreeUI; notifies: string[] } {
	const s = [...(script.selects ?? [])];
	const i = [...(script.inputs ?? [])];
	const c = [...(script.confirms ?? [])];
	const notifies: string[] = [];
	const ui: WorktreeUI = {
		select: async () => s.shift(),
		confirm: async () => c.shift() ?? false,
		input: async () => i.shift(),
		notify: (msg) => notifies.push(msg),
	};
	return { ui, notifies };
}

function makeDeps(opts: RunOpts, ui: WorktreeUI, existsPaths: Set<string>) {
	const { run, calls } = makeRun(opts);
	let execved: { exe: string; argv: string[] } | null = null;
	let exited: number | null = null;
	const displayMsgs: string[] = [];
	const deps: WorktreeDeps = {
		run,
		ui,
		display: (t) => displayMsgs.push(t),
		execve: (exe, argv) => {
			execved = { exe, argv };
		},
		exit: (code) => {
			exited = code;
		},
		stdin: null,
		processArgv: ["/bun", "/path/to/dist/cli.js"],
		existsSync: (p) => existsPaths.has(p),
	};
	return { deps, calls, getExecved: () => execved, getExited: () => exited, displayMsgs };
}

function makeCtx(sessionFile?: string) {
	return {
		cwd: "/repo",
		sessionManager: { getSessionDir: () => "/sess", getSessionFile: () => sessionFile },
	};
}

const sibling = (branch: string) => path.join("/", `repo-wt-${branch}`);

function addCall(calls: { args: string[] }[]) {
	return calls.find(c => c.args[0] === "worktree" && c.args[1] === "add");
}

const SESSION_FILE = "/sess/main.jsonl";

describe("runWorktreeCommand — create/switch", () => {
	test("interactive pick non-current branch → checkout + relaunch with --fork", async () => {
		const { ui } = makeUi({ selects: ["feature"] });
		const { deps, calls, getExecved } = makeDeps(
			{ current: "main", local: ["main", "feature"], worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)?.args).toEqual(["worktree", "add", sibling("feature"), "feature"]);
		expect(getExecved()?.argv).toEqual([
			"/path/to/dist/cli.js",
			"--cwd",
			sibling("feature"),
			"--session-dir",
			"/sess",
			"--fork",
			SESSION_FILE,
		]);
	});

	test("interactive pick current branch → switch to existing worktree", async () => {
		const { ui } = makeUi({ selects: ["feature"], confirms: [true] });
		const { deps, calls, getExecved } = makeDeps(
			{
				current: "feature",
				local: ["feature"],
				worktrees: [
					{ path: "/repo", branch: "refs/heads/main" },
					{ path: sibling("feature"), branch: "refs/heads/feature" },
				],
			},
			ui,
			new Set([SESSION_FILE, sibling("feature")]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		// No new worktree created — switched to existing.
		expect(addCall(calls)).toBeUndefined();
		expect(getExecved()?.argv).toContain("--cwd");
	});

	test("interactive pick current branch already in cwd → warn, no execve", async () => {
		const { ui } = makeUi({ selects: ["feature"] });
		const { deps, calls, getExecved, displayMsgs } = makeDeps(
			{
				current: "feature",
				local: ["feature"],
				worktrees: [{ path: "/repo", branch: "refs/heads/feature" }],
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), { ...deps, existsSync: () => true });
		// cwd is /repo, existing worktree is /repo → warn, no worktree add, no execve
		expect(addCall(calls)).toBeUndefined();
		expect(getExecved()).toBeNull();
		expect(displayMsgs.some(m => m.includes("Already in"))).toBe(true);
	});

	test("interactive pick remote → auto-defaulted tracking branch", async () => {
		const { ui } = makeUi({ selects: ["origin/x"] });
		const { deps, calls } = makeDeps(
			{ current: "main", local: ["main"], remote: ["origin/x"], worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)?.args).toEqual(["worktree", "add", "-b", "x", sibling("x"), "origin/x"]);
	});

	test("--new feat2 main → create branch + worktree + relaunch with --fork", async () => {
		const { ui } = makeUi({});
		const { deps, calls, getExecved } = makeDeps(
			{ current: "main", worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("--new feat2 main", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)?.args).toEqual(["worktree", "add", "-b", "feat2", sibling("feat2"), "main"]);
		expect(getExecved()?.argv).toContain("--fork");
		expect(getExecved()?.argv).toContain(SESSION_FILE);
	});

	test("dirty repo + decline → abort, no worktree add, no execve (D7)", async () => {
		const { ui } = makeUi({ confirms: [false] });
		const { deps, calls, getExecved } = makeDeps(
			{ current: "main", local: ["main", "feature"], porcelain: " M f\n?? g", worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("feature", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)).toBeUndefined();
		expect(getExecved()).toBeNull();
	});

	test("path collision → prompt alternative, use it (D9)", async () => {
		const { ui } = makeUi({ inputs: [`${sibling("feature")}-2`] });
		const { deps, calls } = makeDeps(
			{ current: "main", local: ["main", "feature"], worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set([SESSION_FILE, sibling("feature")]),
		);
		await runWorktreeCommand("feature", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)?.args).toEqual(["worktree", "add", `${sibling("feature")}-2`, "feature"]);
	});

	test("existing worktree + accept → relaunch into it, no worktree add", async () => {
		const { ui } = makeUi({ confirms: [true] });
		const { deps, calls, getExecved } = makeDeps(
			{
				current: "main",
				local: ["main", "feature"],
				worktrees: [
					{ path: "/repo", branch: "refs/heads/main" },
					{ path: sibling("feature"), branch: "refs/heads/feature" },
				],
			},
			ui,
			new Set([SESSION_FILE]),
		);
		await runWorktreeCommand("feature", makeCtx(SESSION_FILE), deps);
		expect(addCall(calls)).toBeUndefined();
		expect(getExecved()?.argv).toContain(sibling("feature"));
	});

	test("no session file → execve argv has no --fork", async () => {
		const { ui } = makeUi({});
		const { deps, getExecved } = makeDeps(
			{ current: "main", local: ["main", "feature"], worktrees: [{ path: "/repo", branch: "refs/heads/main" }] },
			ui,
			new Set(),
		);
		await runWorktreeCommand("feature", makeCtx(undefined), deps);
		const argv = getExecved()?.argv;
		expect(argv).toBeDefined();
		expect(argv).not.toContain("--fork");
	});
});

describe("runWorktreeCommand — list / remove / errors", () => {
	test("not a git repo → display error, no execve", async () => {
		const { ui } = makeUi({});
		const { deps, getExecved, displayMsgs } = makeDeps({ notRepo: true }, ui, new Set());
		await runWorktreeCommand("feature", makeCtx(SESSION_FILE), deps);
		expect(getExecved()).toBeNull();
		expect(displayMsgs.some(m => m.includes("Not a git repository"))).toBe(true);
	});

	test("list → display formatted, no execve (D5)", async () => {
		const { ui } = makeUi({});
		const { deps, getExecved, displayMsgs } = makeDeps(
			{
				worktrees: [
					{ path: "/repo", branch: "refs/heads/main" },
					{ path: sibling("feature"), branch: "refs/heads/feature" },
				],
			},
			ui,
			new Set(),
		);
		await runWorktreeCommand("list", makeCtx(SESSION_FILE), deps);
		expect(getExecved()).toBeNull();
		expect(displayMsgs[0]).toContain("(main)");
		expect(displayMsgs[0]).toContain("feature");
	});

	test("remove + confirm true → run worktree remove (D5)", async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "wt-rm-"));
		try {
			const { ui } = makeUi({ confirms: [true] });
			const { deps, calls, getExecved } = makeDeps({}, ui, new Set());
			await runWorktreeCommand(`remove ${target}`, makeCtx(SESSION_FILE), deps);
			const rm = calls.find(c => c.args[0] === "worktree" && c.args[1] === "remove");
			expect(rm?.args).toEqual(["worktree", "remove", target]);
			expect(getExecved()).toBeNull();
		} finally {
			fs.rmSync(target, { recursive: true, force: true });
		}
	});
});
