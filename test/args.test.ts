import { test, expect, describe } from "bun:test";
import { parseWorktreeArgs } from "../src/args";

describe("parseWorktreeArgs", () => {
	test("empty → interactive", () => {
		expect(parseWorktreeArgs("")).toEqual({ kind: "interactive" });
		expect(parseWorktreeArgs("   ")).toEqual({ kind: "interactive" });
	});

	test("list", () => {
		expect(parseWorktreeArgs("list")).toEqual({ kind: "list" });
		expect(parseWorktreeArgs("list extra ignored")).toEqual({ kind: "list" });
	});

	test("remove", () => {
		expect(parseWorktreeArgs("remove /path/to/wt")).toEqual({
			kind: "remove",
			target: "/path/to/wt",
			force: false,
		});
	});

	test("remove --force", () => {
		expect(parseWorktreeArgs("remove feature --force")).toEqual({
			kind: "remove",
			target: "feature",
			force: true,
		});
		expect(parseWorktreeArgs("remove feature -f")).toEqual({
			kind: "remove",
			target: "feature",
			force: true,
		});
	});

	test("checkout existing branch", () => {
		expect(parseWorktreeArgs("feature")).toEqual({ kind: "checkout", branch: "feature" });
	});

	test("checkout with --at", () => {
		expect(parseWorktreeArgs("feature --at /custom/path")).toEqual({
			kind: "checkout",
			branch: "feature",
			at: "/custom/path",
		});
	});

	test("--new with base", () => {
		expect(parseWorktreeArgs("--new feat2 main")).toEqual({
			kind: "new",
			name: "feat2",
			base: "main",
			at: undefined,
		});
	});

	test("--new without base", () => {
		expect(parseWorktreeArgs("--new feat2")).toEqual({
			kind: "new",
			name: "feat2",
			base: undefined,
			at: undefined,
		});
	});

	test("-n alias", () => {
		expect(parseWorktreeArgs("-n feat2 main")).toEqual({
			kind: "new",
			name: "feat2",
			base: "main",
			at: undefined,
		});
	});

	test("--new with --at", () => {
		expect(parseWorktreeArgs("--new feat2 main --at /p")).toEqual({
			kind: "new",
			name: "feat2",
			base: "main",
			at: "/p",
		});
	});

	test("quote-aware tokenizing", () => {
		expect(parseWorktreeArgs("'/path with spaces'")).toEqual({
			kind: "checkout",
			branch: "/path with spaces",
		});
	});
});
