import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GitExec } from "../src/git";
import {
	addWorktree,
	currentBranch,
	formatWorktreeList,
	listBranches,
	listWorktrees,
	removeWorktree,
	resolveMainRepoRoot,
	statusPorcelain,
} from "../src/git";

const run: GitExec = async (cmd, args, cwd) => {
	const p = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout, stderr, code: code ?? 0 };
};

let tmp: string;

describe("git integration", () => {
	beforeEach(async () => {
		tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wt-git-"));
		await run("git", ["init", "-b", "main"], tmp);
		await run("git", ["config", "user.email", "t@t"], tmp);
		await run("git", ["config", "user.name", "t"], tmp);
		await fs.promises.writeFile(path.join(tmp, "f"), "a");
		await run("git", ["add", "f"], tmp);
		await run("git", ["commit", "-qm", "init"], tmp);
		await run("git", ["branch", "feature"], tmp);
		await run("git", ["branch", "other"], tmp);
	});
	afterEach(async () => {
		// Remove any worktrees before nuking the temp dir.
		const wts = await listWorktrees(tmp, run);
		for (const w of wts) {
			if (path.resolve(w.path) !== path.resolve(tmp)) {
				await run("git", ["worktree", "remove", "--force", w.path], tmp).catch(() => {});
			}
		}
		await fs.promises.rm(tmp, { recursive: true, force: true });
	});

	test("resolveMainRepoRoot from main repo", async () => {
		expect(await resolveMainRepoRoot(tmp, run)).toBe(tmp);
	});

	test("currentBranch", async () => {
		expect(await currentBranch(tmp, run)).toBe("main");
	});

	test("listBranches", async () => {
		const { local, remote } = await listBranches(tmp, run);
		expect(local).toContain("main");
		expect(local).toContain("feature");
		expect(local).toContain("other");
		expect(remote).toEqual([]);
	});

	test("addWorktree for existing branch + resolve from worktree", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-feature");
		await addWorktree(tmp, run, { path: wt, branch: "feature" });
		expect(fs.existsSync(wt)).toBe(true);
		const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], wt);
		expect(head.stdout.trim()).toBe("feature");
		const common = await run("git", ["rev-parse", "--git-common-dir"], wt);
		expect(path.resolve(common.stdout.trim())).toBe(path.resolve(path.join(tmp, ".git")));
		// D4: resolveMainRepoRoot from within a linked worktree → main root.
		expect(await resolveMainRepoRoot(wt, run)).toBe(tmp);
	});

	test("addWorktree for current branch throws", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-main");
		await expect(addWorktree(tmp, run, { path: wt, branch: "main" })).rejects.toThrow();
	});

	test("addWorktree with newBranch + baseRef", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-feat2");
		await addWorktree(tmp, run, { path: wt, newBranch: "feat2", baseRef: "main" });
		const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], wt);
		expect(head.stdout.trim()).toBe("feat2");
	});

	test("addWorktree tracking branch off a ref", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-track");
		await addWorktree(tmp, run, { path: wt, newBranch: "track", baseRef: "feature" });
		const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], wt);
		expect(head.stdout.trim()).toBe("track");
	});

	test("listWorktrees includes main + linked", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-list");
		await addWorktree(tmp, run, { path: wt, branch: "feature" });
		const wts = await listWorktrees(tmp, run);
		expect(wts.length).toBe(2);
		expect(wts.some(w => path.resolve(w.path) === path.resolve(tmp))).toBe(true);
		expect(wts.some(w => path.resolve(w.path) === path.resolve(wt))).toBe(true);
	});

	test("statusPorcelain empty clean / non-empty dirty", async () => {
		expect((await statusPorcelain(tmp, run)).trim()).toBe("");
		await fs.promises.writeFile(path.join(tmp, "dirty"), "x");
		expect((await statusPorcelain(tmp, run)).trim()).not.toBe("");
	});

	test("removeWorktree by path", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-rm");
		await addWorktree(tmp, run, { path: wt, branch: "feature" });
		await removeWorktree(tmp, run, wt);
		const wts = await listWorktrees(tmp, run);
		expect(wts.some(w => path.resolve(w.path) === path.resolve(wt))).toBe(false);
	});

	test("removeWorktree by branch name", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-rmbranch");
		await addWorktree(tmp, run, { path: wt, branch: "feature" });
		await removeWorktree(tmp, run, "feature");
		const wts = await listWorktrees(tmp, run);
		expect(wts.some(w => path.resolve(w.path) === path.resolve(wt))).toBe(false);
	});

	test("formatWorktreeList marks main first", async () => {
		const wt = path.join(path.dirname(tmp), path.basename(tmp) + "-wt-fmt");
		await addWorktree(tmp, run, { path: wt, branch: "feature" });
		const wts = await listWorktrees(tmp, run);
		const out = formatWorktreeList(wts);
		expect(out).toContain("(main)");
		expect(out).toContain("feature");
		expect(out).toContain(wt);
	});
});
