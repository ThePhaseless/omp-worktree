import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import { runWorktreeCommand } from "./command";

/**
 * omp extension factory. No top-level side effects so `omp plugin install`
 * factory validation passes. Registers the `/worktree` command.
 */
export default function worktreeExtension(pi: ExtensionAPI): void {
	pi.setLabel("Git Worktree");
	const run = (cmd: string, args: string[], cwd: string) => pi.exec(cmd, args, { cwd });
	pi.registerCommand("worktree", {
		description: "Create a git worktree from a chosen branch and switch omp into it (shared conversation)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await runWorktreeCommand(
				args,
				{ cwd: ctx.cwd, sessionManager: ctx.sessionManager },
				{
					run,
					ui: ctx.ui,
					display: (text) =>
						pi.sendMessage(
							{ customType: "worktree", content: text, display: true, attribution: "agent" },
							{ triggerTurn: false },
						),
					execve: (exe, argv, env) => process.execve(exe, argv, env as string[]),
					exit: (code) => process.exit(code),
					stdin: process.stdin as typeof process.stdin | null,
					processArgv: process.argv,
					existsSync: fs.existsSync,
					realpathSync: fs.realpathSync,
				},
			);
		},
	});
}
