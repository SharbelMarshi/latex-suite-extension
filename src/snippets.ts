import { Transaction, TransactionSpec } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

import LatexSuiteExtension from './main';
import { isInsideMath } from './keyboard-switch';

/**
 * Built-in math-mode snippets, so no Latex Suite configuration is needed:
 * - each RTL text command name expands to the command with the cursor inside
 *   the braces ("he" -> "\he{|}", "ar" -> "\ar{|}")
 * - "sol" expands to "\solve", which immediately triggers solving
 *
 * A trigger only fires when the character before it is not a letter or
 * backslash (so "\theta" and "\arcsin" never expand), only inside math, and
 * never inside \text{...}-style commands or an RTL command's argument.
 */

interface BuiltinSnippet {
	trigger: string;
	replacement: string;
	cursorOffset: number;
}

const TEXT_COMMANDS = /^(text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|operatorname)$/;

function sanitizeCommands(commands: string[]): string[] {
	return commands
		.map(cmd => cmd.trim().replace(/^\\/, ''))
		.filter(cmd => /^[A-Za-z]+$/.test(cmd));
}

function buildSnippets(rtlTextCommands: string[]): BuiltinSnippet[] {
	const snippets: BuiltinSnippet[] = sanitizeCommands(rtlTextCommands).map(cmd => ({
		trigger: cmd,
		replacement: `\\${cmd}{}`,
		cursorOffset: cmd.length + 2,    // right inside the braces
	}));
	snippets.push({ trigger: 'sol', replacement: '\\solve', cursorOffset: 6 });
	return snippets.sort((a, b) => b.trigger.length - a.trigger.length);
}

/** Innermost \command{ ... } whose argument is still open at pos. */
function enclosingCommandName(state: EditorState, pos: number): string | null {
	const from = Math.max(0, pos - 1000);
	const text = state.sliceDoc(from, pos);
	const commandRe = /\\([a-zA-Z]+)\s*\{/g;
	let found: string | null = null;

	let match;
	while ((match = commandRe.exec(text)) !== null) {
		let depth = 1;
		let i = match.index + match[0].length;
		while (i < text.length && depth > 0) {
			const ch = text[i];
			if (ch === '\\') { i += 2; continue; }
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			i++;
		}
		if (depth > 0) found = match[1];    // still open at pos => encloses it
	}
	return found;
}

// contexts where a "$" is literal text, never a math delimiter
const CODE_CONTEXT = /code|comment|frontmatter|escape|tag|hashtag/i;

/**
 * Auto-pairing for "$":
 * - typing "$" inserts "$|$" with the cursor in the middle
 * - typing "$" right before an existing closing "$" (including the hidden
 *   " {}$" form) steps over it instead of inserting another one
 * - typing "$" with a selection wraps the selection: "$selection$|"
 * Skipped for escaped "\$" and inside code/comments/frontmatter.
 */
export function getDollarAutopair(tr: Transaction): TransactionSpec | null {
	const state = tr.startState;
	if (state.selection.ranges.length !== 1) return null;

	// Exactly one change: Obsidian's own selection auto-pair wraps by
	// dispatching TWO "$" insertions, and that transaction must pass through
	// untouched — treating one of its halves as a type-through would swallow
	// the wrap.
	let single: { fromA: number; toA: number; inserted: string } | null = null;
	let changeCount = 0;
	tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
		changeCount++;
		single = { fromA, toA, inserted: inserted.toString() };
	});
	if (changeCount !== 1 || single === null) return null;
	const { fromA, toA, inserted } = single as { fromA: number; toA: number; inserted: string };
	if (inserted !== '$') return null;

	if (state.sliceDoc(Math.max(0, fromA - 1), fromA) === '\\') return null;
	if (CODE_CONTEXT.test(syntaxTree(state).cursorAt(fromA, 1).node.name)) return null;

	// selection wrap (only reached when Obsidian's own auto-pair is off,
	// in which case the "$" would otherwise REPLACE the selection)
	if (toA > fromA) {
		const text = state.sliceDoc(fromA, toA);
		return {
			changes: { from: fromA, to: toA, insert: `$${text}$` },
			selection: { anchor: fromA + text.length + 2 },
		};
	}

	// a second "$" inside the fresh empty pair upgrades it to display math: $$|$$
	if (state.sliceDoc(Math.max(0, fromA - 1), fromA) === '$'
		&& state.sliceDoc(fromA, fromA + 1) === '$'
		&& state.sliceDoc(Math.max(0, fromA - 2), Math.max(0, fromA - 1)) !== '$'
		&& state.sliceDoc(fromA + 1, fromA + 2) !== '$') {
		return {
			changes: { from: fromA, insert: '$$' },
			selection: { anchor: fromA + 1 },
		};
	}

	// type-through an existing closing "$"
	if (state.sliceDoc(fromA, fromA + 1) === '$') {
		return { selection: { anchor: fromA + 1 } };
	}
	if (state.sliceDoc(fromA, fromA + 4) === ' {}$' && isInsideMath(state, fromA)) {
		return { selection: { anchor: fromA + 4 } };
	}

	// auto-close a fresh "$"
	if (!isInsideMath(state, fromA)) {
		return {
			changes: { from: fromA, insert: '$$' },
			selection: { anchor: fromA + 1 },
		};
	}
	return null;
}

/**
 * If this input transaction just completed a snippet trigger, return the
 * transaction spec that expands it instead; null otherwise.
 */
export function getSnippetExpansion(plugin: LatexSuiteExtension, tr: Transaction): TransactionSpec | null {
	const state = tr.startState;
	if (state.selection.ranges.length !== 1) return null;

	const snippets = buildSnippets(plugin.settings.rtlTextCommands);
	const rtlCommands = sanitizeCommands(plugin.settings.rtlTextCommands);
	let result: TransactionSpec | null = null;

	tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
		if (result !== null || inserted.length !== 1) return;
		const typed = inserted.toString();
		if (!/[A-Za-z]/.test(typed)) return;

		const before = state.sliceDoc(Math.max(0, fromA - 32), fromA) + typed;
		for (const snippet of snippets) {
			if (!before.endsWith(snippet.trigger)) continue;
			const boundary = before[before.length - snippet.trigger.length - 1];
			if (boundary !== undefined && /[A-Za-z\\]/.test(boundary)) continue;

			const from = fromA - (snippet.trigger.length - 1);
			if (from < 0) break;
			if (!isInsideMath(state, fromA)) break;
			const enclosing = enclosingCommandName(state, fromA);
			if (enclosing && (TEXT_COMMANDS.test(enclosing) || rtlCommands.includes(enclosing))) break;

			result = {
				changes: { from, to: toA, insert: snippet.replacement },
				selection: { anchor: from + snippet.cursorOffset },
			};
			break;
		}
	});

	return result;
}
