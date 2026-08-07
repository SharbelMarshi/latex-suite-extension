import { EditorView } from '@codemirror/view';
import { Notice } from 'obsidian';

import LatexSuiteExtension from './main';
import { isInsideMath } from './keyboard-switch';
import { computeSolveInsertion } from './solve-core';

const SOLVE = '\\solve';

/**
 * When "\solve" is typed inside math, replace it with the numerically solved
 * last equation of the line (see solve-core.ts). Runs on the next tick since
 * dispatching during an update is not allowed; triggers only on real typing
 * (never on undo/redo, so undoing a solve doesn't immediately re-solve).
 */
export const createSolveListener = (plugin: LatexSuiteExtension) =>
	EditorView.updateListener.of((update) => {
		if (!update.docChanged) return;
		// fire on typing AND on snippet expansions (no user event), but never
		// on undo/redo — otherwise undoing a solve would immediately re-solve
		if (update.transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return;
		const pos = update.state.selection.main.head;
		if (pos < SOLVE.length || update.state.sliceDoc(pos - SOLVE.length, pos) !== SOLVE) return;
		const view = update.view;
		window.setTimeout(() => trySolve(plugin, view));
	});

function trySolve(plugin: LatexSuiteExtension, view: EditorView) {
	const state = view.state;
	const pos = state.selection.main.head;
	if (pos < SOLVE.length || state.sliceDoc(pos - SOLVE.length, pos) !== SOLVE) return;
	if (!isInsideMath(state)) return;

	const line = state.doc.lineAt(pos);
	let content = state.sliceDoc(line.from, pos - SOLVE.length);
	// inline math: only look at the current $...$; display math lines have no "$"
	const dollarIndex = content.lastIndexOf('$');
	if (dollarIndex >= 0) content = content.slice(dollarIndex + 1);
	// the flicker machinery's hidden opening braces
	content = content.replace(/^\{\} ?/, '');

	const insert = computeSolveInsertion(content, plugin.settings.solveSeparator);
	if (insert === null) {
		new Notice('Latex Suite Extension: could not evaluate the last equation.');
		return;
	}

	view.dispatch({
		changes: { from: pos - SOLVE.length, to: pos, insert },
		selection: { anchor: pos - SOLVE.length + insert.length },
	});
}
