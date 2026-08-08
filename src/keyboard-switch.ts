import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Notice, Platform } from 'obsidian';
import LatexSuiteExtension from './main';
import { CANDIDATE_REGEX, shouldTolerantRender } from './tolerant-math';

declare global {
	interface Window {
		/** Electron's require; absent on mobile */
		require?: NodeRequire;
	}
}

/** Node modules, loaded lazily so this file stays loadable on mobile. */
function desktopNodeModules(): { fs: typeof import('fs'); childProcess: typeof import('child_process') } | null {
	if (!Platform.isDesktopApp || !window.require) return null;
	return {
		fs: window.require('fs') as typeof import('fs'),
		childProcess: window.require('child_process') as typeof import('child_process'),
	};
}

export type RtlLanguage = 'he' | 'ar';

/**
 * What the keyboard should be, by cursor position, in priority order:
 * - 'he' / 'ar': inside a \he{...} / \ar{...} argument (innermost wins)
 * - 'math': inside $...$ or $$...$$ but not inside an RTL command
 * - 'note': regular note text
 */
export type KeyboardContext = RtlLanguage | 'math' | 'note';

const IM_SELECT_LOCATIONS = ['/opt/homebrew/bin/im-select', '/usr/local/bin/im-select'];

// how far around the cursor to look for an enclosing \he{...} / \ar{...}
const SCAN_WINDOW = 2000;

/**
 * Returns which RTL text command argument the cursor is inside, if any.
 * Finds `\he{` / `\ar{` before the cursor and brace-matches (skipping
 * escaped characters) to see whether the argument encloses the cursor;
 * the innermost enclosing command wins. An unclosed argument counts as
 * extending to the end of the scanned window, so switching already works
 * while the closing brace hasn't been typed yet.
 */
export function findRtlLanguageAtCursor(state: EditorState, commands: string[]): RtlLanguage | null {
	const langCommands = commands
		.map(cmd => cmd.trim().replace(/^\\/, ''))
		.filter((cmd): cmd is RtlLanguage => cmd === 'he' || cmd === 'ar');
	if (langCommands.length === 0) return null;

	const pos = state.selection.main.head;
	const from = Math.max(0, pos - SCAN_WINDOW);
	const text = state.sliceDoc(from, Math.min(state.doc.length, pos + SCAN_WINDOW));
	const cursor = pos - from;

	const commandRe = new RegExp(`\\\\(${langCommands.join('|')})\\{`, 'g');
	let found: RtlLanguage | null = null;

	let match;
	while ((match = commandRe.exec(text)) !== null) {
		const argStart = match.index + match[0].length;
		if (argStart > cursor) break;

		let depth = 1;
		let i = argStart;
		while (i < text.length && depth > 0) {
			const ch = text[i];
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			i++;
		}
		const argEnd = depth === 0 ? i - 1 : text.length;

		if (cursor >= argStart && cursor <= argEnd) {
			found = match[1] as RtlLanguage;
		}
	}

	return found;
}

/**
 * Whether the cursor is inside inline/display math. The syntax tree decides,
 * with delimiter tokens counted so that a cursor right after the closing "$"
 * (or right before the opening one) is already outside. Unconverted tolerant
 * candidates ("$   x   $") count as inside too.
 */
export function isInsideMath(state: EditorState, pos = state.selection.main.head): boolean {
	const tree = syntaxTree(state);
	const left = tree.cursorAt(pos, -1).node.name;
	const right = tree.cursorAt(pos, 1).node.name;
	if (/math/i.test(left) && !left.includes('math-end')) return true;
	if (/math/i.test(right) && !right.includes('math-begin')) return true;

	// not parser-math — maybe a tolerant candidate not converted yet
	const line = state.doc.lineAt(pos);
	CANDIDATE_REGEX.lastIndex = 0;
	let match;
	while ((match = CANDIDATE_REGEX.exec(line.text)) !== null) {
		const start = line.from + match.index;
		const end = start + match[0].length;
		if (pos > start && pos < end && shouldTolerantRender(match[1])) return true;
	}
	return false;
}

export function findKeyboardContext(state: EditorState, commands: string[]): KeyboardContext {
	const lang = findRtlLanguageAtCursor(state, commands);
	if (lang) return lang;
	return isInsideMath(state) ? 'math' : 'note';
}

/**
 * Switches the system keyboard input source via the external `im-select`
 * tool according to the cursor's KeyboardContext. Each context maps to a
 * configurable input source; an empty ID means "leave the keyboard alone in
 * this context". Switching happens only on context transitions, so manually
 * changing the layout mid-context is respected until the cursor crosses a
 * boundary. Desktop only.
 */
export class KeyboardSwitcher {
	private plugin: LatexSuiteExtension;
	private currentContext: KeyboardContext | null = null;
	private targetContext: KeyboardContext | null = null;
	private debounceTimeout = -1;
	private queue: Promise<void> = Promise.resolve();
	private warnedMissing = false;

	constructor(plugin: LatexSuiteExtension) {
		this.plugin = plugin;
	}

	setContext(context: KeyboardContext | null) {
		if (!Platform.isDesktopApp) return;
		this.targetContext = context;
		window.clearTimeout(this.debounceTimeout);
		this.debounceTimeout = window.setTimeout(() => {
			const target = this.targetContext;
			this.queue = this.queue
				.then(() => this.transition(target))
				.catch(() => { /* logged in transition() */ });
		}, 150);
	}

	destroy() {
		window.clearTimeout(this.debounceTimeout);
	}

	private resolveBinary(): string | null {
		const node = desktopNodeModules();
		if (!node) return null;
		const configured = this.plugin.settings.imSelectPath.trim();
		if (configured) {
			return node.fs.existsSync(configured) ? configured : null;
		}
		for (const location of IM_SELECT_LOCATIONS) {
			if (node.fs.existsSync(location)) return location;
		}
		return null;
	}

	private exec(bin: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const node = desktopNodeModules();
			if (!node) {
				reject(new Error('Node.js modules are unavailable'));
				return;
			}
			node.childProcess.execFile(bin, args, { timeout: 2000 }, (error, stdout) => {
				if (error) reject(error);
				else resolve(String(stdout).trim());
			});
		});
	}

	private resolveInputSource(context: KeyboardContext): string {
		const settings = this.plugin.settings;
		switch (context) {
			case 'he': return settings.hebrewInputSource;
			case 'ar': return settings.arabicInputSource;
			case 'math': return settings.mathInputSource;
			case 'note': return settings.noteInputSource;
		}
	}

	private async transition(context: KeyboardContext | null) {
		if (context === null || context === this.currentContext) return;
		this.currentContext = context;

		const id = this.resolveInputSource(context).trim();
		if (!id) return;    // empty ID: leave the keyboard alone in this context

		const bin = this.resolveBinary();
		if (!bin) {
			if (!this.warnedMissing) {
				this.warnedMissing = true;
				new Notice('Latex Suite Extension: im-select not found. Install it (brew install im-select) or set its path in the plugin settings to enable keyboard auto-switching.');
			}
			return;
		}

		try {
			await this.exec(bin, [id]);
		} catch (error) {
			console.warn('Latex Suite Extension: failed to switch input source', error);
		}
	}
}
