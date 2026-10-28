import { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Editor, MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile } from 'obsidian';

import { DEFAULT_SETTINGS, LatexSuiteExtensionSettingTab, LatexSuiteExtensionSettings } from './settings';
import { createViewPlugin } from 'decoration-and-atomic-range';
import { tolerantMathPostProcessor, tolerantMathViewPlugin } from 'tolerant-math';
import { MathJaxBidiCommandPatcher, RTL_FONTS_VAR, buildRtlFontStack } from 'rtl';
import { KeyboardSwitcher, findKeyboardContext } from 'keyboard-switch';
import { createSolveListener } from 'solve';
import { selectionSatisfies } from 'utils';
import { makeTransactionFilter } from 'transaction-filter';
import { DocumentStore } from 'document-store';
import {
	checkRequiredFields,
	createFormFieldPostProcessor,
	createFormFieldViewPlugin,
	insertFormField,
} from 'forminput';
import { findFormFields, renderFieldsAsText } from 'forminput-core';
import {
	MeaningModal,
	MeaningTooltip,
	createAnnotationPostProcessor,
	createAnnotationViewPlugin,
	registerMeaningTooltip,
	resolvedAnnotationsFor,
} from 'annotations';
import {
	ALL_OCCURRENCES,
	Annotation,
	annotationInRange,
	createAnnotation,
	findOccurrences,
	nextAnnotationId,
	removeAnnotation,
	upsertAnnotation,
} from 'annotations-core';


export default class LatexSuiteExtension extends Plugin {
	settings: LatexSuiteExtensionSettings;
	/**
	 * a view plugin that provides
	 * - decorations to hide braces adjacent to "$"s
	 * - & atomic ranges to treat each of "${} " and " {}$" as one character
	 */
	viewPlugin: Extension[] = [];
	/**
	 * Indicates whether the previous transaction was the first of the two transactions
	 * (1. text replacement & 2. cursor position change) that Latex Suite's "box current equation"
	 * command produces or not. See the comment in the makeTransactionFilter() method for details.
	 */
	_latexSuiteBoxing = false;
	/** patches MathJax with the configured RTL text commands */
	private mathjaxPatcher?: MathJaxBidiCommandPatcher;
	/** switches the OS keyboard layout inside \he{...} / \ar{...} (desktop only) */
	keyboardSwitcher?: KeyboardSwitcher;
	/** per-note form field values and word meanings (stored in data.json) */
	store: DocumentStore;
	/**
	 * Word-meaning decorations. Held in a mutable array like `viewPlugin` so
	 * that adding or removing a meaning — which changes no document text — can
	 * force CodeMirror to rebuild by swapping in a new extension instance.
	 */
	annotationPlugin: Extension[] = [];
	/** shared popover for word meanings */
	private meaningTooltip?: MeaningTooltip;
	/** original MathJax tex2chtml, kept for restoring the \displaystyle patch */
	private origTex2chtml?: (source: string, options?: { display?: boolean }) => HTMLElement;

	async onload() {

		/** Settings */
		await this.loadSettings();
		await this.saveSettings();
		this.addSettingTab(new LatexSuiteExtensionSettingTab(this.app, this));

		/** RTL math text: patch MathJax before anything gets rendered */
		await this.refreshMathJax();

		/** \displaystyle for inline math (MathJax is loaded by now) */
		this.patchInlineDisplaystyle();
		this.applyRtlFonts();

		/** Editor extensions */
		this.registerEditorExtension(this.viewPlugin);
		this.remakeViewPlugin();
		this.registerEditorExtension(makeTransactionFilter(this));

		/** Tolerant math rendering ($ x $, $ $) — always on; it's the point of this plugin */
		this.registerEditorExtension(tolerantMathViewPlugin);
		this.registerMarkdownPostProcessor(tolerantMathPostProcessor);

		/** \solve: numerically evaluate the last equation */
		this.registerEditorExtension(createSolveListener(this));

		/** \forminput text fields and word meanings */
		this.registerMarkdownPostProcessor(createFormFieldPostProcessor(this));
		this.registerEditorExtension(this.annotationPlugin);
		this.remakeAnnotationPlugin();
		this.registerMarkdownPostProcessor(createAnnotationPostProcessor(this));
		this.meaningTooltip = registerMeaningTooltip(this);
		this.registerDocumentCommands();
		this.registerDocumentMenu();
		this.registerFileEvents();

		/** Keyboard auto-switching: note language <-> math <-> \he{...} / \ar{...} */
		if (Platform.isDesktopApp) {
			this.keyboardSwitcher = new KeyboardSwitcher(this);
			this.registerEditorExtension(EditorView.updateListener.of((update) => {
				if (!this.settings.autoSwitchKeyboard || !this.keyboardSwitcher) return;
				if (!update.selectionSet && !update.docChanged) return;
				if (!update.view.hasFocus) return;
				this.keyboardSwitcher.setContext(
					findKeyboardContext(update.state, this.settings.rtlTextCommands)
				);
			}));
			this.addCommand({
				id: 'toggle-keyboard-auto-switch',
				name: 'Toggle keyboard auto-switching',
				callback: async () => {
					this.settings.autoSwitchKeyboard = !this.settings.autoSwitchKeyboard;
					await this.saveSettings();
					new Notice(`Keyboard auto-switching ${this.settings.autoSwitchKeyboard ? 'enabled' : 'disabled'}`);
				},
			});
		}
	}

	onunload() {
		this.mathjaxPatcher?.destroy();
		this.mathjaxPatcher = undefined;
		this.meaningTooltip?.destroy();
		this.meaningTooltip = undefined;
		this.store?.destroy();
		document.body.style.removeProperty(RTL_FONTS_VAR);
		this.keyboardSwitcher?.destroy();
		this.keyboardSwitcher = undefined;
		if (this.origTex2chtml && window.MathJax) {
			window.MathJax.tex2chtml = this.origTex2chtml;
			this.origTex2chtml = undefined;
		}
	}

	/**
	 * Wraps MathJax's tex2chtml so inline math (display: false) is rendered
	 * with a leading \displaystyle. Reading the setting at render time means
	 * the toggle needs no re-patching; math already on screen re-renders when
	 * its note is reopened.
	 */
	private patchInlineDisplaystyle() {
		const mathJax = window.MathJax;
		if (!mathJax?.tex2chtml || this.origTex2chtml) return;
		// binding keeps `this` correct both in the wrapper and when restoring
		const original = mathJax.tex2chtml.bind(mathJax);
		this.origTex2chtml = original;
		mathJax.tex2chtml = (source: string, options?: { display?: boolean }) => {
			if (this.settings.inlineDisplaystyle
				&& options?.display === false
				&& !source.includes('\\displaystyle')) {
				source = '\\displaystyle ' + source;
			}
			return original(source, options);
		};
	}

	/**
	 * Math text elements read the font stack from this CSS variable (see
	 * applyRtlFontVariable in rtl.ts). The trailing comma joins it onto
	 * MathJax's own font list; with no fonts configured the variable is
	 * removed and MathJax's fonts are used as-is.
	 */
	applyRtlFonts() {
		const stack = buildRtlFontStack(this.settings.hebrewFont, this.settings.arabicFont);
		if (stack) {
			document.body.setCssProps({ [RTL_FONTS_VAR]: `${stack},` });
		} else {
			document.body.style.removeProperty(RTL_FONTS_VAR);
		}
	}

	/* ---------------- text fields & word meanings ---------------- */

	private registerDocumentCommands() {
		this.addCommand({
			id: 'insert-text-field',
			name: 'Insert text field',
			editorCallback: (editor: Editor) => insertFormField(this.app, editor),
		});

		this.addCommand({
			id: 'check-required-fields',
			name: 'Check required text fields',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				checkRequiredFields(this, editor, view.file?.path ?? '');
			},
		});

		this.addCommand({
			id: 'copy-with-field-values',
			name: 'Copy note with text field values',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const path = view.file?.path ?? '';
				const source = editor.getValue();
				if (findFormFields(source).length === 0) {
					new Notice('No text fields in this note.');
					return;
				}
				await navigator.clipboard.writeText(
					renderFieldsAsText(source, this.store.getValues(path))
				);
				new Notice('Copied with field values filled in.');
			},
		});

		this.addCommand({
			id: 'add-meaning',
			name: 'Add meaning to selection',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				const path = view.file?.path;
				if (!path || !editor.somethingSelected()) return false;
				if (checking) return true;
				this.addMeaning(
					editor,
					path,
					editor.posToOffset(editor.getCursor('from')),
					editor.posToOffset(editor.getCursor('to')),
				);
				return true;
			},
		});
	}

	private registerDocumentMenu() {
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
			const path = info.file?.path;
			if (!path) return;

			// Capture the range now: opening a modal moves focus, and the live
			// selection is gone by the time the menu item runs.
			const doc = editor.getValue();
			const from = editor.posToOffset(editor.getCursor('from'));
			const to = editor.posToOffset(editor.getCursor('to'));

			if (this.settings.annotationsEnabled) {
				const hit = annotationInRange(resolvedAnnotationsFor(this, doc, path), from, to);
				if (hit) {
					menu.addItem(item => item
						.setTitle('Edit meaning')
						.setIcon('pencil')
						.onClick(() => this.editMeaning(path, hit.annotation, doc, hit.from)));
					menu.addItem(item => item
						.setTitle('Remove meaning')
						.setIcon('trash')
						.onClick(() => this.removeMeaning(path, hit.annotation.id)));
				} else if (to > from) {
					menu.addItem(item => item
						.setTitle('Add meaning')
						.setIcon('book-open')
						.onClick(() => this.addMeaning(editor, path, from, to)));
				}
			}

			if (this.settings.formFieldsEnabled) {
				menu.addItem(item => item
					.setTitle('Insert text field')
					.setIcon('text-cursor-input')
					.onClick(() => insertFormField(this.app, editor)));
			}
		}));
	}

	/** Per-note data is keyed by path, so follow renames and drop deletions. */
	private registerFileEvents() {
		this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) this.store.renameDocument(oldPath, file.path);
		}));
		this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
			if (file instanceof TFile) this.store.deleteDocument(file.path);
		}));
	}

	private addMeaning(editor: Editor, path: string, from: number, to: number) {
		const doc = editor.getValue();
		const raw = doc.slice(from, to);
		const text = raw.trim();
		if (!text) {
			new Notice('Select a word or phrase first.');
			return;
		}
		const start = from + raw.indexOf(text);
		const occurrences = findOccurrences(doc, text).length;

		new MeaningModal(this.app, text, null, occurrences, (result) => {
			const annotations = this.store.getAnnotations(path);
			const annotation = createAnnotation({
				source: doc,
				start,
				text,
				meaning: result.meaning,
				note: result.note,
				applyAll: result.applyAll,
				id: nextAnnotationId(annotations),
				createdAt: Date.now(),
			});
			this.store.setAnnotations(path, upsertAnnotation(annotations, annotation));
			void this.store.flush();
			this.refreshDocumentViews();
		}).open();
	}

	private editMeaning(path: string, existing: Annotation, doc: string, resolvedFrom: number) {
		const occurrences = findOccurrences(doc, existing.text);

		new MeaningModal(this.app, existing.text, existing, occurrences.length, (result) => {
			const index = occurrences.indexOf(resolvedFrom);
			const updated: Annotation = {
				...existing,
				meaning: result.meaning,
				note: result.note,
				occurrence: result.applyAll
					? ALL_OCCURRENCES
					: (existing.occurrence === ALL_OCCURRENCES ? Math.max(0, index) : existing.occurrence),
			};
			this.store.setAnnotations(path, upsertAnnotation(this.store.getAnnotations(path), updated));
			void this.store.flush();
			this.refreshDocumentViews();
		}).open();
	}

	private removeMeaning(path: string, id: string) {
		this.store.setAnnotations(path, removeAnnotation(this.store.getAnnotations(path), id));
		void this.store.flush();
		this.refreshDocumentViews();
		this.meaningTooltip?.hide();
	}

	remakeAnnotationPlugin() {
		this.annotationPlugin.length = 0;
		this.annotationPlugin.push(createAnnotationViewPlugin(this));
		this.app.workspace.updateOptions();
	}

	/** Store changes are invisible to the editor, so rebuild what renders them. */
	private refreshDocumentViews() {
		this.remakeAnnotationPlugin();
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView) view.previewMode?.rerender(true);
		}
	}

	async loadSettings() {
		const data: unknown = await this.loadData();
		const stored = (data ?? {}) as Partial<LatexSuiteExtensionSettings> & { documents?: unknown };
		this.store ??= new DocumentStore(() => this.saveSettings());
		this.store.load(stored.documents);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		delete (this.settings as Partial<LatexSuiteExtensionSettings> & { documents?: unknown }).documents;
		this.settings.rtlTextCommands = Array.isArray(stored.rtlTextCommands)
			? stored.rtlTextCommands
			: [...DEFAULT_SETTINGS.rtlTextCommands];
		this.settings.solveAngleNames = Array.isArray(stored.solveAngleNames)
			? stored.solveAngleNames
			: [...DEFAULT_SETTINGS.solveAngleNames];
		// migrate the pre-0.0.2 solve separator default
		if (this.settings.solveSeparator === "\\quad \\xrightarrow{} \\quad") {
			this.settings.solveSeparator = DEFAULT_SETTINGS.solveSeparator;
		}
	}

	/** Settings and per-note data share one data.json; write them together. */
	async saveSettings() {
		await this.saveData({ ...this.settings, documents: this.store?.serialize() ?? {} });
	}

	async refreshMathJax() {
		this.mathjaxPatcher?.destroy();
		this.mathjaxPatcher = new MathJaxBidiCommandPatcher(this.settings.rtlTextCommands);
		await this.mathjaxPatcher.init();
	}

	shouldIgnore(state: EditorState): boolean {
		return this.settings.disableInTable && selectionSatisfies(
			state,
			node => node.name.includes("HyperMD-table") || node.name.includes("hmd-table")
		);
	}

	remakeViewPlugin() {
		this.viewPlugin.length = 0;
		this.viewPlugin.push(createViewPlugin(this));
		this.viewPlugin.push(createFormFieldViewPlugin(this));
		this.app.workspace.updateOptions();
	}
}
