import { test, expect, describe } from "bun:test";
import * as path from "node:path";
import {
	buildExecveArgv,
	buildRelaunchArgs,
	computeDefaultWorktreePath,
	localNameForRemote,
	sanitizeBranchName,
	shortRef,
} from "../src/paths";

describe("sanitizeBranchName", () => {
	test("replaces slashes and illegal chars", () => {
		expect(sanitizeBranchName("feature/foo")).toBe("feature-foo");
		expect(sanitizeBranchName("a b/c")).toBe("a-b-c");
	});
	test("collapses repeated dashes", () => {
		expect(sanitizeBranchName("a---b")).toBe("a-b");
	});
	test("strips leading/trailing dashes", () => {
		expect(sanitizeBranchName("--abc--")).toBe("abc");
	});
	test("keeps allowed chars", () => {
		expect(sanitizeBranchName("ok.d_e-1")).toBe("ok.d_e-1");
	});
});

describe("computeDefaultWorktreePath", () => {
	test("sibling of repo root with sanitized branch", () => {
		expect(computeDefaultWorktreePath("/repo", "feature/foo")).toBe(
			path.join("/", "repo-wt-feature-foo"),
		);
	});
});

describe("localNameForRemote", () => {
	test("strips first remote namespace", () => {
		expect(localNameForRemote("origin/x")).toBe("x");
	});
	test("keeps trailing path after first slash", () => {
		expect(localNameForRemote("origin/foo/bar")).toBe("foo/bar");
	});
	test("returns as-is when no slash", () => {
		expect(localNameForRemote("x")).toBe("x");
	});
});

describe("shortRef", () => {
	test("strips refs/heads/", () => {
		expect(shortRef("refs/heads/x")).toBe("x");
	});
	test("strips refs/remotes/ leaving remote namespace", () => {
		expect(shortRef("refs/remotes/origin/x")).toBe("origin/x");
	});
	test("passes through short refs", () => {
		expect(shortRef("x")).toBe("x");
	});
});

describe("buildRelaunchArgs", () => {
	test("without session file omits --fork", () => {
		expect(buildRelaunchArgs({ cwd: "/w", sessionDir: "/s" })).toEqual([
			"--cwd",
			"/w",
			"--session-dir",
			"/s",
		]);
	});
	test("with session file appends --fork", () => {
		expect(buildRelaunchArgs({ cwd: "/w", sessionDir: "/s", sessionFile: "/f" })).toEqual([
			"--cwd",
			"/w",
			"--session-dir",
			"/s",
			"--fork",
			"/f",
		]);
	});
});

describe("buildExecveArgv", () => {
	test("script mode keeps exe as argv[0] + script as argv[1]", () => {
		const { exe, argv } = buildExecveArgv(["/bun", "/path/to/dist/cli.js"], ["--cwd", "/w"]);
		expect(exe).toBe(process.execPath);
		expect(argv).toEqual([process.execPath, "/path/to/dist/cli.js", "--cwd", "/w"]);
	});
	test("compiled mode uses exe as argv[0]", () => {
		const { exe, argv } = buildExecveArgv(["/bun"], ["--cwd", "/w"]);
		expect(exe).toBe(process.execPath);
		expect(argv).toEqual([process.execPath, "--cwd", "/w"]);
	});
});
