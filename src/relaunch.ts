import { buildExecveArgv } from "./paths";

export interface RelaunchDeps {
	execve: (exe: string, argv: string[], env: object) => void;
	exit: (code: number) => void;
	stdin?: { isTTY?: boolean; setRawMode?(mode: boolean): void } | null;
	processArgv: string[];
	env?: object;
	display: (text: string) => void;
}

/**
 * Re-exec omp in place with the given CLI flags (D6). Restores raw terminal mode
 * before replacing the image. On success the image is replaced and nothing below
 * the `execve` call runs. On failure, prints the exact manual command and exits
 * cleanly (graceful fallback).
 */
export function relaunchOmp(flags: string[], deps: RelaunchDeps): void {
	if (deps.stdin?.isTTY && typeof deps.stdin.setRawMode === "function") {
		deps.stdin.setRawMode(false);
	}
	const { exe, argv } = buildExecveArgv(deps.processArgv, flags);
	try {
		deps.execve(exe, argv, deps.env ?? { ...process.env });
	} catch {
		deps.display(`Relaunch failed; run manually:\nomp ${flags.join(" ")}`);
		deps.exit(0);
	}
}
