import { App, MarkdownPostProcessorContext, Modal, Setting, editorInfoField } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';

import LatexSuiteExtension from './main';
import {
	ALL_OCCURRENCES,
	Annotation,
	ResolvedAnnotation,
	resolveAnnotations,
} from './annotations-core';

/**
 * Rendering and interaction for word meanings.
 *
 * The meaning and note travel with the decoration as data attributes, so the
 * tooltip works identically in Live Preview and Reading view without looking
 * anything up. All text reaches the DOM through attributes and `setText`,
 * never innerHTML.
 */

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 8;

function markAttributes(annotation: Annotation): Record<string, string> {
	return {
		'data-meaning-id': annotation.id,
		'data-meaning-word': annotation.text,
		'data-meaning': annotation.meaning,
		'data-meaning-note': annotation.note,
		tabindex: '0',
		role: 'note',
		'aria-label': annotation.note
			? `${annotation.text}: ${annotation.meaning}. ${annotation.note}`
			: `${annotation.text}: ${annotation.meaning}`,
	};
}

/* ---------------- Tooltip ---------------- */

/**
 * One shared popover. It is `pointer-events: none` (see styles.css) so it can
 * never block text selection or editing, and it flips below the word when
 * there is not enough room above.
 */
export class MeaningTooltip {
	private el: HTMLElement | null = null;
	private currentTarget: HTMLElement | null = null;

	private ensureEl(): HTMLElement {
		if (this.el) return this.el;
		const el = document.body.createDiv({ cls: 'lse-meaning-tooltip' });
		el.id = 'lse-meaning-tooltip';
		el.setAttr('role', 'tooltip');
		el.hide();
		this.el = el;
		return el;
	}

	show(target: HTMLElement): void {
		if (this.currentTarget === target) return;    // moving within the same word
		const word = target.dataset.meaningWord ?? '';
		const meaning = target.dataset.meaning ?? '';
		const note = target.dataset.meaningNote ?? '';
		if (!meaning && !note) return;

		const el = this.ensureEl();
		el.empty();
		el.createDiv({ cls: 'lse-meaning-word', text: word });
		el.createDiv({ cls: 'lse-meaning-text', text: meaning });
		if (note) el.createDiv({ cls: 'lse-meaning-note', text: note });

		el.show();
		this.currentTarget = target;
		target.setAttr('aria-describedby', el.id);
		this.position(target, el);
	}

	private position(target: HTMLElement, el: HTMLElement): void {
		el.removeClass('lse-meaning-tooltip-below');
		// measure with the tooltip laid out but before it is placed
		el.setCssStyles({ left: '0px', top: '0px' });

		const rect = target.getBoundingClientRect();
		const size = el.getBoundingClientRect();

		const fitsAbove = rect.top - size.height - TOOLTIP_GAP >= VIEWPORT_MARGIN;
		const top = fitsAbove
			? rect.top - size.height - TOOLTIP_GAP
			: rect.bottom + TOOLTIP_GAP;
		if (!fitsAbove) el.addClass('lse-meaning-tooltip-below');

		const maxLeft = window.innerWidth - size.width - VIEWPORT_MARGIN;
		const left = Math.min(
			Math.max(VIEWPORT_MARGIN, rect.left + rect.width / 2 - size.width / 2),
			Math.max(VIEWPORT_MARGIN, maxLeft),
		);

		el.setCssStyles({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
	}

	hide(): void {
		this.currentTarget?.removeAttribute('aria-describedby');
		this.currentTarget = null;
		this.el?.hide();
	}

	destroy(): void {
		this.el?.remove();
		this.el = null;
		this.currentTarget = null;
	}
}

/**
 * Wire hover/focus/Escape for every annotated span, in both views, via
 * delegation so dynamically rendered spans are covered too.
 */
export function registerMeaningTooltip(plugin: LatexSuiteExtension): MeaningTooltip {
	const tooltip = new MeaningTooltip();

	const target = (event: Event): HTMLElement | null => {
		const node = event.target;
		if (!(node instanceof HTMLElement)) return null;
		return node.closest<HTMLElement>('.lse-meaning');
	};

	plugin.registerDomEvent(document, 'mouseover', (event) => {
		const el = target(event);
		if (el) tooltip.show(el);
	});
	plugin.registerDomEvent(document, 'mouseout', (event) => {
		if (target(event)) tooltip.hide();
	});
	plugin.registerDomEvent(document, 'focusin', (event) => {
		const el = target(event);
		if (el) tooltip.show(el);
	});
	plugin.registerDomEvent(document, 'focusout', (event) => {
		if (target(event)) tooltip.hide();
	});
	plugin.registerDomEvent(document, 'keydown', (event) => {
		if (event.key === 'Escape') tooltip.hide();
	});
	plugin.registerDomEvent(window, 'scroll', () => tooltip.hide(), true);

	return tooltip;
}

/* ---------------- Live Preview ---------------- */

export const createAnnotationViewPlugin = (plugin: LatexSuiteExtension) => ViewPlugin.fromClass(
	class implements PluginValue {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			if (!plugin.settings.annotationsEnabled) return builder.finish();

			const path = view.state.field(editorInfoField, false)?.file?.path ?? '';
			const annotations = plugin.store.getAnnotations(path);
			if (annotations.length === 0) return builder.finish();

			const resolved = resolveAnnotations(view.state.doc.toString(), annotations);
			for (const { annotation, from, to } of resolved) {
				const visible = view.visibleRanges.some(r => from < r.to && to > r.from);
				if (!visible) continue;
				builder.add(from, to, Decoration.mark({
					class: 'lse-meaning',
					attributes: markAttributes(annotation),
				}));
			}

			return builder.finish();
		}
	}, {
	decorations: instance => instance.decorations,
});

/** Resolved annotations for the document currently in `view`. */
export function resolvedAnnotationsFor(plugin: LatexSuiteExtension, doc: string, path: string): ResolvedAnnotation[] {
	return resolveAnnotations(doc, plugin.store.getAnnotations(path));
}

/* ---------------- Reading view ---------------- */

/**
 * Decorate annotated text in rendered markdown. Offsets are resolved against
 * the rendered text of the block with the same core resolver used in the
 * editor; ranges split across inline markup are skipped rather than guessed.
 */
export const createAnnotationPostProcessor = (plugin: LatexSuiteExtension) =>
	(element: HTMLElement, context: MarkdownPostProcessorContext) => {
		if (!plugin.settings.annotationsEnabled) return;

		const annotations = plugin.store.getAnnotations(context.sourcePath);
		if (annotations.length === 0) return;

		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				for (let el = node.parentElement; el && el !== element.parentElement; el = el.parentElement) {
					const tag = el.tagName;
					if (tag === 'CODE' || tag === 'PRE' || tag.startsWith('MJX')
						|| el.classList.contains('math') || el.classList.contains('lse-meaning')) {
						return NodeFilter.FILTER_REJECT;
					}
				}
				return NodeFilter.FILTER_ACCEPT;
			}
		});

		const nodes: { node: Text; start: number }[] = [];
		let text = '';
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			nodes.push({ node, start: text.length });
			text += node.nodeValue ?? '';
		}
		if (text.length === 0) return;

		const resolved = resolveAnnotations(text, annotations);
		if (resolved.length === 0) return;

		// group by text node, then apply back to front so offsets stay valid
		const perNode = new Map<Text, { from: number; to: number; annotation: Annotation }[]>();
		for (const { annotation, from, to } of resolved) {
			const entry = nodes.find(n => from >= n.start && to <= n.start + (n.node.nodeValue?.length ?? 0));
			if (!entry) continue;    // split across inline markup: leave it alone
			const list = perNode.get(entry.node) ?? [];
			list.push({ from: from - entry.start, to: to - entry.start, annotation });
			perNode.set(entry.node, list);
		}

		for (const [node, ranges] of perNode) {
			ranges.sort((a, b) => b.from - a.from);
			for (const { from, to, annotation } of ranges) {
				const tail = node.splitText(from);
				tail.splitText(to - from);
				const span = createSpan({ cls: 'lse-meaning', text: tail.nodeValue ?? '' });
				for (const [key, value] of Object.entries(markAttributes(annotation))) {
					span.setAttr(key, value);
				}
				tail.replaceWith(span);
			}
		}
	};

/* ---------------- Add / edit dialog ---------------- */

export interface MeaningModalResult {
	meaning: string;
	note: string;
	applyAll: boolean;
}

export class MeaningModal extends Modal {
	private meaning: string;
	private note: string;
	private applyAll: boolean;
	private errorEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly word: string,
		private readonly existing: Annotation | null,
		private readonly occurrences: number,
		private readonly onSubmit: (result: MeaningModalResult) => void,
	) {
		super(app);
		this.meaning = existing?.meaning ?? '';
		this.note = existing?.note ?? '';
		this.applyAll = existing?.occurrence === ALL_OCCURRENCES;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.existing ? 'Edit meaning' : 'Add meaning');
		contentEl.addClass('lse-modal');

		new Setting(contentEl)
			.setName('Selected text')
			.addText(text => {
				text.setValue(this.word);
				text.inputEl.setAttr('readonly', 'true');
				text.inputEl.addClass('lse-modal-readonly');
			});

		new Setting(contentEl)
			.setName('Meaning')
			.setDesc('Shown in the tooltip.')
			.addTextArea(area => {
				area.setPlaceholder('What this means…')
					.setValue(this.meaning)
					.onChange(value => {
						this.meaning = value;
						this.errorEl?.setText('');
					});
				area.inputEl.rows = 3;
			});

		new Setting(contentEl)
			.setName('Example or note')
			.setDesc('Optional, shown under the meaning.')
			.addTextArea(area => {
				area.setPlaceholder('Optional')
					.setValue(this.note)
					.onChange(value => { this.note = value; });
				area.inputEl.rows = 2;
			});

		if (this.occurrences > 1 || this.applyAll) {
			new Setting(contentEl)
				.setName('Apply to every occurrence')
				.setDesc(`"${this.word}" appears ${this.occurrences} times in this note.`)
				.addToggle(toggle => toggle
					.setValue(this.applyAll)
					.onChange(value => { this.applyAll = value; }));
		}

		this.errorEl = contentEl.createDiv({ cls: 'lse-modal-error' });
		this.errorEl.setAttr('role', 'alert');

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText('Save')
				.setCta()
				.onClick(() => this.submit()));
	}

	private submit(): void {
		if (this.meaning.trim() === '') {
			this.errorEl?.setText('A meaning is required.');
			return;
		}
		this.onSubmit({
			meaning: this.meaning.trim(),
			note: this.note.trim(),
			applyAll: this.applyAll,
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
