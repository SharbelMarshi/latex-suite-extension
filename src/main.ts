import { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Notice, Platform, Plugin } from 'obsidian';

import { DEFAULT_SETTINGS, LatexSuiteExtensionSettingTab, LatexSuiteExtensionSettings } from './settings';
import { createViewPlugin } from 'decoration-and-atomic-range';
import { tolerantMathPostProcessor, tolerantMathViewPlugin } from 'tolerant-math';
import { MathJaxBidiCommandPatcher, buildRtlFontStack } from 'rtl';
import { KeyboardSwitcher, findKeyboardContext } from 'keyboard-switch';
import { createSolveListener } from 'solve';
import { selectionSatisfies } from 'utils';
import { makeTransactionFilter } from 'transaction-filter';


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
		document.body.removeClass('lse-rtl-fonts');
		document.body.style.removeProperty('--lse-rtl-fonts');
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
		const original = mathJax.tex2chtml.bind(mathJax);
		this.origTex2chtml = mathJax.tex2chtml;
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
	 * The font rule itself lives statically in styles.css; this only toggles
	 * the body class gating it and fills in the font stack via a CSS variable.
	 */
	applyRtlFonts() {
		const stack = buildRtlFontStack(this.settings.hebrewFont, this.settings.arabicFont);
		if (stack) {
			document.body.addClass('lse-rtl-fonts');
			document.body.style.setProperty('--lse-rtl-fonts', stack);
		} else {
			document.body.removeClass('lse-rtl-fonts');
			document.body.style.removeProperty('--lse-rtl-fonts');
		}
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.rtlTextCommands = Array.isArray(data?.rtlTextCommands)
			? data.rtlTextCommands
			: [...DEFAULT_SETTINGS.rtlTextCommands];
		// migrate the pre-0.0.2 solve separator default
		if (this.settings.solveSeparator === "\\quad \\xrightarrow{} \\quad") {
			this.settings.solveSeparator = DEFAULT_SETTINGS.solveSeparator;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
		this.app.workspace.updateOptions();
	}
}
