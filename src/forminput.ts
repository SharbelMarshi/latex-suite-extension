import { App, Editor, MarkdownPostProcessorContext, Modal, Notice, Setting, editorInfoField } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

import LatexSuiteExtension from './main';
import { EXCLUDED_NODE } from './tolerant-math';
import {
	DEFAULT_FIELD_WIDTH,
	FormFieldOptions,
	FormFieldSpec,
	MAX_FIELD_WIDTH,
	MIN_FIELD_WIDTH,
	clampWidth,
	fieldLabel,
	findFormFields,
	isPersistable,
	resolveFieldValue,
	sanitizeId,
	serializeFormField,
	validateFields,
} from './forminput-core';

/**
 * Rendering and editing for `\forminput[...]`.
 *
 * Everything user-supplied (label, placeholder, value) reaches the DOM through
 * `createEl`/`setText`/`value`, never innerHTML, so a label containing markup
 * is shown as text and cannot inject anything.
 */

/** The DOM for one field, shared by Live Preview and Reading view. */
function renderField(
	spec: FormFieldSpec,
	value: string,
	onChange: ((value: string) => void) | null,
): HTMLElement {
	const wrapper = createSpan({ cls: 'lse-field' });
	wrapper.dataset.fieldId = spec.id;
	if (spec.required) wrapper.addClass('lse-field-required');

	if (spec.label) {
		wrapper.createSpan({ cls: 'lse-field-label', text: spec.label });
	}

	const control = spec.multiline
		? wrapper.createEl('textarea', { cls: 'lse-field-input lse-field-multiline' })
		: wrapper.createEl('input', { cls: 'lse-field-input', type: 'text' });

	control.value = value;
	control.placeholder = spec.placeholder;
	control.setAttr('aria-label', spec.label || spec.placeholder || 'Text field');
	if (spec.required) control.setAttr('aria-required', 'true');
	if (spec.multiline) control.setAttr('rows', '3');
	control.style.width = `${spec.width ?? DEFAULT_FIELD_WIDTH}px`;
	if (!onChange) control.setAttr('readonly', 'true');

	const error = wrapper.createSpan({ cls: 'lse-field-error' });
	error.setAttr('role', 'alert');

	let touched = value.trim() !== '';
	const validate = () => {
		const invalid = spec.required && control.value.trim() === '';
		wrapper.toggleClass('lse-field-invalid', invalid && touched);
		error.setText(invalid && touched ? `${fieldLabel(spec)} is required` : '');
	};

	if (onChange) {
		control.addEventListener('input', () => {
			touched = true;
			onChange(control.value);
			validate();
		});
		control.addEventListener('blur', () => {
			touched = true;
			validate();
		});
		// keep typing inside the field from reaching editor shortcuts
		control.addEventListener('keydown', (event) => {
			if ((event as KeyboardEvent).key === 'Escape') control.blur();
			event.stopPropagation();
		});
	}

	validate();
	return wrapper;
}

/* ---------------- Live Preview ---------------- */

class FormFieldWidget extends WidgetType {
	constructor(
		private readonly plugin: LatexSuiteExtension,
		private readonly spec: FormFieldSpec,
		private readonly value: string,
		private readonly path: string,
	) {
		super();
	}

	eq(other: FormFieldWidget): boolean {
		return other.value === this.value
			&& other.path === this.path
			&& JSON.stringify(other.spec) === JSON.stringify(this.spec);
	}

	toDOM(): HTMLElement {
		return renderField(this.spec, this.value, (value) => {
			if (!isPersistable(this.spec) || !this.path) return;
			this.plugin.store.setValue(this.path, this.spec.id, value);
		});
	}

	/** true = the editor leaves these events alone, so the input stays usable */
	ignoreEvent(): boolean {
		return true;
	}
}

export const createFormFieldViewPlugin = (plugin: LatexSuiteExtension) => ViewPlugin.fromClass(
	class implements PluginValue {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			if (!plugin.settings.formFieldsEnabled) return builder.finish();

			const state = view.state;
			const path = state.field(editorInfoField, false)?.file?.path ?? '';
			const values = plugin.store.getValues(path);
			const tree = syntaxTree(state);

			for (const { from, to } of view.visibleRanges) {
				const text = state.sliceDoc(from, to);
				for (const match of findFormFields(text)) {
					const start = from + match.start;
					const end = from + match.end;

					// leave code blocks, comments and math to Obsidian
					if (EXCLUDED_NODE.test(tree.cursorAt(start, 1).node.name)) continue;

					// show the raw command while the cursor is inside it, so the
					// options stay editable — same convention as tolerant math
					const overlapsSelection = state.selection.ranges.some(
						range => range.from <= end && range.to >= start
					);
					if (overlapsSelection) continue;

					builder.add(start, end, Decoration.replace({
						widget: new FormFieldWidget(
							plugin,
							match.spec,
							resolveFieldValue(match.spec, values),
							path,
						),
					}));
				}
			}

			return builder.finish();
		}
	}, {
	decorations: instance => instance.decorations,
});

/* ---------------- Reading view ---------------- */

export const createFormFieldPostProcessor = (plugin: LatexSuiteExtension) =>
	(element: HTMLElement, context: MarkdownPostProcessorContext) => {
		if (!plugin.settings.formFieldsEnabled) return;

		const path = context.sourcePath;
		const values = plugin.store.getValues(path);

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
		while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

		for (const textNode of textNodes) {
			const text = textNode.nodeValue ?? '';
			const matches = findFormFields(text);
			if (matches.length === 0) continue;

			const fragment = createFragment();
			let last = 0;
			for (const match of matches) {
				fragment.append(text.slice(last, match.start));
				fragment.append(renderField(
					match.spec,
					resolveFieldValue(match.spec, values),
					(value) => {
						if (!isPersistable(match.spec) || !path) return;
						plugin.store.setValue(path, match.spec.id, value);
					},
				));
				last = match.end;
			}
			fragment.append(text.slice(last));
			textNode.replaceWith(fragment);
		}
	};

/* ---------------- Insert dialog ---------------- */

export class InsertFormFieldModal extends Modal {
	private options: FormFieldOptions = {
		id: '',
		label: '',
		placeholder: '',
		defaultValue: '',
		width: DEFAULT_FIELD_WIDTH,
		required: false,
		multiline: false,
	};
	private previewEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;

	constructor(app: App, private readonly onSubmit: (command: string) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Insert text field');
		contentEl.addClass('lse-modal');

		new Setting(contentEl)
			.setName('ID')
			.setDesc('Key the entered value is stored under. Required, and unique per note.')
			.addText(text => text
				.setPlaceholder('name')
				.onChange(value => {
					this.options.id = value;
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Label')
			.setDesc('Shown before the field.')
			.addText(text => text
				.setPlaceholder('Full name')
				.onChange(value => {
					this.options.label = value;
					if (!this.options.id) {
						// convenience: derive an id from the label until one is typed
						this.options.id = sanitizeId(value.toLowerCase().replace(/\s+/g, '-'));
					}
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Placeholder')
			.setDesc('Hint shown while the field is empty.')
			.addText(text => text
				.setPlaceholder('Enter your name')
				.onChange(value => {
					this.options.placeholder = value;
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Default value')
			.setDesc('Used until something is typed into the field.')
			.addText(text => text
				.onChange(value => {
					this.options.defaultValue = value;
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Width')
			.setDesc(`Pixels, ${MIN_FIELD_WIDTH}–${MAX_FIELD_WIDTH}.`)
			.addText(text => text
				.setPlaceholder(String(DEFAULT_FIELD_WIDTH))
				.onChange(value => {
					const n = parseFloat(value);
					this.options.width = Number.isFinite(n) ? clampWidth(n) : DEFAULT_FIELD_WIDTH;
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Required')
			.setDesc('Show a validation message while the field is empty.')
			.addToggle(toggle => toggle
				.setValue(false)
				.onChange(value => {
					this.options.required = value;
					this.refresh();
				}));

		new Setting(contentEl)
			.setName('Multiline')
			.setDesc('Render a text area instead of a single-line box.')
			.addToggle(toggle => toggle
				.setValue(false)
				.onChange(value => {
					this.options.multiline = value;
					this.refresh();
				}));

		contentEl.createEl('p', { cls: 'lse-modal-caption', text: 'Command to insert' });
		this.previewEl = contentEl.createEl('code', { cls: 'lse-modal-preview' });
		this.errorEl = contentEl.createDiv({ cls: 'lse-modal-error' });
		this.errorEl.setAttr('role', 'alert');

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText('Insert')
				.setCta()
				.onClick(() => this.submit()));

		this.refresh();
	}

	private refresh(): void {
		this.previewEl?.setText(serializeFormField(this.options));
		this.errorEl?.setText('');
	}

	private submit(): void {
		if (!sanitizeId(this.options.id ?? '')) {
			this.errorEl?.setText('An ID is required so the entered value can be saved.');
			return;
		}
		this.onSubmit(serializeFormField(this.options));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/* ---------------- Editor commands ---------------- */

export function insertFormField(app: App, editor: Editor): void {
	new InsertFormFieldModal(app, (command) => {
		editor.replaceSelection(command);
		editor.focus();
	}).open();
}

/** Report required fields that are still empty in the active note. */
export function checkRequiredFields(plugin: LatexSuiteExtension, editor: Editor, path: string): void {
	const specs = findFormFields(editor.getValue()).map(m => m.spec);
	const errors = validateFields(specs, plugin.store.getValues(path));

	if (errors.length === 0) {
		new Notice(specs.length === 0 ? 'No text fields in this note.' : 'All required fields are filled.');
		return;
	}
	new Notice(`${errors.length} required field${errors.length === 1 ? '' : 's'} empty:\n` +
		errors.map(e => `• ${e.label}`).join('\n'));
}
