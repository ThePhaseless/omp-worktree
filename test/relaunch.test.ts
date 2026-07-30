import { test, expect, describe } from "bun:test";
import { relaunchOmp } from "../src/relaunch";

describe("relaunchOmp", () => {
	test("restores raw mode and execves with the composed argv", () => {
		const calls: string[] = [];
		let execved: { exe: string; argv: string[]; env: object } | null = null;
		let exited: number | null = null;
		relaunchOmp(["--cwd", "/w", "--session-dir", "/s", "--fork", "/f"], {
			execve: (exe, argv, env) => {
				execved = { exe, argv, env };
			},
			exit: (code) => {
				exited = code;
			},
			stdin: {
				isTTY: true,
				setRawMode: (mode) => {
					calls.push(`rawmode=${mode}`);
				},
			},
			processArgv: ["/bun", "/path/to/dist/cli.js"],
			env: { FOO: "bar" },
			display: () => {},
		});
		expect(calls).toEqual(["rawmode=false"]);
		expect(execved).not.toBeNull();
		expect(execved!.exe).toBe(process.execPath);
		expect(execved!.argv).toEqual([
			process.execPath,
			"/path/to/dist/cli.js",
			"--cwd",
			"/w",
			"--session-dir",
			"/s",
			"--fork",
			"/f",
		]);
		expect(execved!.env).toEqual({ FOO: "bar" });
		expect(exited).toBeNull();
	});

	test("on execve failure, prints the manual command and exits 0", () => {
		const displayed: string[] = [];
		let exited: number | null = null;
		relaunchOmp(["--cwd", "/w", "--session-dir", "/s"], {
			execve: () => {
				throw new Error("noexec");
			},
			exit: (code) => {
				exited = code;
			},
			stdin: null,
			processArgv: ["/bun", "/cli.js"],
			display: (text) => displayed.push(text),
		});
		expect(exited).toBe(0);
		expect(displayed.length).toBe(1);
		expect(displayed[0]).toContain("omp --cwd /w --session-dir /s");
	});

	test("does not call setRawMode when stdin has no TTY", () => {
		let execved = false;
		relaunchOmp(["--cwd", "/w"], {
			execve: () => {
				execved = true;
			},
			exit: () => {},
			stdin: { isTTY: false },
			processArgv: ["/bun", "/cli.js"],
			display: () => {},
		});
		expect(execved).toBe(true);
	});
});
