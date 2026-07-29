export type WorktreeAction =
	| { kind: "interactive" }
	| { kind: "checkout"; branch: string; at?: string }
	| { kind: "new"; name: string; base?: string; at?: string }
	| { kind: "list" }
	| { kind: "remove"; target: string; force?: boolean };

/**
 * Quote-aware whitespace tokenizer. Splits on unquoted whitespace; single and
 * double quotes are accepted and stripped.
 */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

/**
 * Parse the `/worktree` command line. First match wins:
 * - empty → interactive
 * - `list` → list
 * - `remove` → target = next token; `--force` later sets force
 * - `--new`/`-n` → name = next token; base = following token unless it starts
 *   with `--at`
 * - else first token = existing branch → checkout
 * - `--at <path>` anywhere in checkout/new sets `at` (stripped from
 *   branch/base parsing)
 */
export function parseWorktreeArgs(input: string): WorktreeAction {
	const tokens = tokenize(input.trim());
	if (tokens.length === 0) return { kind: "interactive" };

	const head = tokens[0];
	if (head === "list") return { kind: "list" };

	if (head === "remove") {
		const target = tokens[1];
		const force = tokens.includes("--force") || tokens.includes("-f");
		if (!target) return { kind: "list" };
		return { kind: "remove", target, force };
	}

	if (head === "--new" || head === "-n") {
		const name = tokens[1];
		if (!name) return { kind: "interactive" };
		// Collect `--at <path>` from the remainder.
		let at: string | undefined;
		let base: string | undefined;
		for (let i = 2; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "--at") {
				at = tokens[i + 1];
				i++;
				continue;
			}
			if (t === "--force" || t === "-f") continue;
			if (base === undefined && t !== undefined) base = t;
		}
		return { kind: "new", name, base, at };
	}

	// checkout: first token is the branch. Scan remaining for --at.
	const branch = head;
	let at: string | undefined;
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--at") {
			at = tokens[i + 1];
			i++;
		}
	}
	return { kind: "checkout", branch, at };
}
