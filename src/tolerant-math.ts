import { MarkdownPostProcessor, finishRenderMath, renderMath } from 'obsidian';
import { ChangeSpec, EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * Obsidian refuses to render `$ x $` (spaces right after the opening `$` or
 * right before the closing `$`) and `$ $` (nothing inside) as inline math.
 * This module renders those "tolerant" candidates anyway, in both Live Preview
 * (via replace decorations) and Reading view (via a markdown post processor).
 *
 * A candidate is rendered if its content is whitespace-only or has whitespace
 * on either side (e.g. `$ x+y $`, `$\frac{480}{430}   $`). The one exception:
 * a one-sided candidate whose content has internal spaces but no math-looking
 * characters ("$5 and $ 6") is treated as prose around currency, not math.
 */

// One `$ ... $` pair on a single line; skips `$$` and escaped `\$` delimiters.
export const CANDIDATE_REGEX = /(?<![$\\])\$(?!\$)([^$\n]*?)(?<!\\)\$(?!\$)/g;

// Node names whose regions must never be re-rendered: real math (already
// handled by Obsidian), code, comments, frontmatter, escapes and tags.
export const EXCLUDED_NODE = /math|code|comment|frontmatter|escape|tag|hashtag/i;

/**
 * When the selection touches a tolerant math candidate ("$   x   $" — not
 * recognized as math by Obsidian because of the spaces), convert it to the
 * brace-guarded form "${}   x   {}$". That form IS parser-valid math, so
 * everything downstream works natively: Obsidian colors the source, Latex
 * Suite's snippets/tabout fire, and this plugin's decorations hide the braces.
 * On leaving the math, the usual cleanup trims it down to valid "$x$".
 *
 * The braced result is no longer a candidate (its content starts with "{"),
 * so this can never fire twice on the same region.
 */
export function getTolerantConversionChanges(state: EditorState, selection: EditorSelection): ChangeSpec[] {
	const tree = syntaxTree(state);
	const changes: ChangeSpec[] = [];
	const seen = new Set<number>();

	for (const range of selection.ranges) {
		const line = state.doc.lineAt(range.head);
		CANDIDATE_REGEX.lastIndex = 0;

		let match;
		while ((match = CANDIDATE_REGEX.exec(line.text)) !== null) {
			const start = line.from + match.index;
			const end = start + match[0].length;
			if (range.from > end || range.to < start) continue;    // selection not touching
			if (seen.has(start)) continue;
			if (!shouldTolerantRender(match[1])) continue;
			const nodeName = tree.cursorAt(start, 1).node.name;
			if (EXCLUDED_NODE.test(nodeName) || /table/i.test(nodeName)) continue;

			seen.add(start);
			changes.push({ from: start + 1, insert: "{} " });
			changes.push({ from: end - 1, insert: " {}" });
		}
	}

	return changes;
}

export function shouldTolerantRender(content: string): boolean {
	if (content.length === 0) return false;
	const trimmed = content.trim();
	if (trimmed.length === 0) return true;
	// No spaces touching the delimiters: valid math, Obsidian renders it itself
	if (trimmed === content) return false;
	if (/^[ \t]/.test(content) && /[ \t]$/.test(content)) return true;
	// One-sided space: render unless the content reads like prose caught
	// between two unrelated dollar signs ("$5 and $ 6"), i.e. it has internal
	// spaces but nothing that looks like math notation.
	return !/[ \t]/.test(trimmed) || /[\\{}^_=+*/()[\]<>|]/.test(trimmed);
}

function renderTolerantMath(content: string): HTMLElement {
	const wrapper = createSpan({ cls: 'lse-tolerant-math' });
	wrapper.append(renderMath(content.trim(), false));
	return wrapper;
}

// While the cursor is inside a tolerant candidate, the raw source is shown.
// These marks give it the same CSS classes Obsidian puts on native math
// source, so themes (and Latex Suite users' eyes) see the usual colors.
const MATH_BEGIN_MARK = Decoration.mark({
	class: 'cm-formatting cm-formatting-math cm-formatting-math-begin cm-math',
});
const MATH_END_MARK = Decoration.mark({
	class: 'cm-formatting cm-formatting-math cm-formatting-math-end cm-math',
});
const MATH_CONTENT_MARK = Decoration.mark({ class: 'cm-math' });

class TolerantMathWidget extends WidgetType {
	constructor(readonly content: string) {
		super();
	}

	eq(other: TolerantMathWidget): boolean {
		return other.content === this.content;
	}

	toDOM(): HTMLElement {
		const el = renderTolerantMath(this.content);
		void finishRenderMath();
		return el;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export const tolerantMathViewPlugin = ViewPlugin.fromClass(
	class implements PluginValue {
		decorations: DecorationSet;
		conversionTimeout = -1;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		destroy() {
			window.clearTimeout(this.conversionTimeout);
		}

		/**
		 * Dispatching is not allowed during an update, so the conversion of a
		 * touched candidate into the brace-guarded form runs on the next tick.
		 * This catches every way a cursor can end up on a candidate — clicking,
		 * arrow keys, typing the closing "$", or Latex Suite wrapping a
		 * selection — the state is re-verified at fire time.
		 */
		scheduleConversion(view: EditorView) {
			if (this.conversionTimeout !== -1) return;
			this.conversionTimeout = window.setTimeout(() => {
				this.conversionTimeout = -1;
				if (view.composing) return;
				const changes = getTolerantConversionChanges(view.state, view.state.selection);
				if (changes.length > 0) {
					view.dispatch({ changes });
				}
			});
		}

		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			const state = view.state;
			const tree = syntaxTree(state);

			for (const { from, to } of view.visibleRanges) {
				const text = state.sliceDoc(from, to);
				CANDIDATE_REGEX.lastIndex = 0;
				let match;
				while ((match = CANDIDATE_REGEX.exec(text)) !== null) {
					if (!shouldTolerantRender(match[1])) continue;

					const start = from + match.index;
					const end = start + match[0].length;

					// Leave real math / code / etc. to Obsidian
					const openName = tree.cursorAt(start, 1).node.name;
					const closeName = tree.cursorAt(end - 1, 1).node.name;
					if (EXCLUDED_NODE.test(openName) || EXCLUDED_NODE.test(closeName)) continue;

					// Show the raw source while the cursor touches the candidate,
					// colored like native math source
					const overlapsSelection = state.selection.ranges.some(
						range => range.from <= end && range.to >= start
					);
					if (overlapsSelection) {
						this.scheduleConversion(view);
						builder.add(start, start + 1, MATH_BEGIN_MARK);
						if (end - 1 > start + 1) {
							builder.add(start + 1, end - 1, MATH_CONTENT_MARK);
						}
						builder.add(end - 1, end, MATH_END_MARK);
						continue;
					}

					builder.add(start, end, Decoration.replace({
						widget: new TolerantMathWidget(match[1]),
					}));
				}
			}

			return builder.finish();
		}
	}, {
	decorations: instance => instance.decorations,
});

export const tolerantMathPostProcessor: MarkdownPostProcessor = (element) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			for (let el = node.parentElement; el && el !== element.parentElement; el = el.parentElement) {
				const tag = el.tagName;
				if (tag === 'CODE' || tag === 'PRE' || tag.startsWith('MJX') || el.classList.contains('math')) {
					return NodeFilter.FILTER_REJECT;
				}
			}
			return NodeFilter.FILTER_ACCEPT;
		}
	});

	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}

	let rendered = false;
	for (const textNode of textNodes) {
		const text = textNode.nodeValue ?? '';
		CANDIDATE_REGEX.lastIndex = 0;

		let match;
		let last = 0;
		let fragment: DocumentFragment | null = null;
		while ((match = CANDIDATE_REGEX.exec(text)) !== null) {
			if (!shouldTolerantRender(match[1])) continue;

			fragment ??= createFragment();
			fragment.append(text.slice(last, match.index));
			fragment.append(renderTolerantMath(match[1]));
			last = match.index + match[0].length;
		}

		if (fragment) {
			fragment.append(text.slice(last));
			textNode.replaceWith(fragment);
			rendered = true;
		}
	}

	if (rendered) {
		void finishRenderMath();
	}
};
