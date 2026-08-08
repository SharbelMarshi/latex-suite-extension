import { finishRenderMath, loadMathJax } from 'obsidian';

declare global {
	interface Window {
		MathJax: {
			tex2chtml(source: string, options?: { display?: boolean }): HTMLElement;
		};
	}
	// present at runtime (modern Chromium/WebKit), missing from TS 4.7's lib.dom
	interface Document {
		adoptedStyleSheets: CSSStyleSheet[];
	}
	interface CSSStyleSheet {
		replaceSync(text: string): void;
	}
}

export const DEFAULT_RTL_TEXT_COMMANDS = ['he', 'ar'];

export const DEFAULT_HEBREW_FONT = 'David CLM';
export const DEFAULT_ARABIC_FONT = '';

// Arabic script blocks (base + supplements + presentation forms)
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * MathJax 3 renders text one character per element (mjx-utext), so the font
 * shapes every letter in isolation — which breaks Arabic, whose letters must
 * join into initial/medial/final forms (mathjax/MathJax#3041; fixed upstream
 * in MathJax 4). Workaround: merge each run of adjacent single-character
 * elements containing Arabic back into one element, so the font shaper sees
 * whole words and joins the letters. Runs without Arabic are left untouched.
 */
export function mergeSplitRtlText(root: ParentNode) {
	const handled = new Set<Element>();
	for (const el of Array.from(root.querySelectorAll('mjx-utext'))) {
		if (handled.has(el)) continue;

		const run: Element[] = [el];
		let next = el.nextElementSibling;
		while (next && next.tagName === el.tagName) {
			run.push(next);
			handled.add(next);
			next = next.nextElementSibling;
		}
		if (run.length < 2) continue;

		const text = run.map(e => e.textContent ?? '').join('');
		if (!ARABIC_RE.test(text)) continue;

		el.textContent = text;
		(el as HTMLElement).style.removeProperty('width');
		for (const extra of run.slice(1)) extra.remove();
	}
}

/**
 * Font stack for Hebrew/Arabic text inside math, applied through the
 * `--lse-rtl-fonts` CSS variable consumed by a static rule in styles.css.
 * MathJax renders characters missing from its own math fonts (e.g. Hebrew and
 * Arabic letters) as `mjx-utext` elements, so that rule changes only
 * non-Latin text. Both fonts go into one stack: the browser picks the first
 * font that actually contains each glyph, so Hebrew letters use the Hebrew
 * font and Arabic letters fall through to the Arabic one.
 */
export function buildRtlFontStack(hebrewFont: string, arabicFont: string): string {
	return [hebrewFont, arabicFont]
		.map(font => font.trim().replace(/["\\]/g, ''))
		.filter(Boolean)
		.map(font => `"${font}"`)
		.join(', ');
}

/**
 * Adds basic RTL text support to MathJax expressions:
 * - registers configurable macros (default `\he{...}` and `\ar{...}`) that
 *   expand to `\class{mjx-rtl}{\text{...}}`, so RTL text needs just one short
 *   command — the `\text{}` is baked in. Nest math inside via `\(...\)`.
 * - mirrors MathJax's physical padding/margin rules as logical properties
 *   so spacing stays correct inside RTL runs
 */
export class MathJaxBidiCommandPatcher {
	private cmds: string[];
	private mathjaxStyleObserver?: MutationObserver;
	private arabicShapingObserver?: MutationObserver;
	/** constructed stylesheet holding the logical-property mirror rules */
	private logicalSheet?: CSSStyleSheet;

	constructor(cmds: string[]) {
		this.cmds = cmds;
	}

	async init() {
		await loadMathJax();

		// Fix Arabic letter joining in already-rendered math, and keep fixing
		// every piece of math rendered from now on (reading view, live preview
		// widgets, hover previews, ...)
		mergeSplitRtlText(document.body);
		this.arabicShapingObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (!node.instanceOf(HTMLElement)) continue;
					if (node.tagName.startsWith('MJX')) {
						mergeSplitRtlText(node.parentElement ?? node);
					} else if (node.querySelector('mjx-utext')) {
						mergeSplitRtlText(node);
					}
				}
			}
		});
		this.arabicShapingObserver.observe(document.body, { childList: true, subtree: true });

		// Extend MathJax macros; command names are restricted to letters
		// (TeX control words), with any leading backslash the user typed removed
		const defs = this.cmds
			.map(cmd => cmd.trim().replace(/^\\/, ''))
			.filter(cmd => /^[A-Za-z]+$/.test(cmd))
			.map(cmd => `\\def\\${cmd}#1{\\class{mjx-rtl}{\\text{#1}}}`);
		if (defs.length === 0) return;
		window.MathJax.tex2chtml(defs.join('\n'), { display: false });

		// Patch styles after initial MathJax stylesheet flush
		await finishRenderMath();
		this.patchStyles();

		// Patch styles on MathJax stylesheet change
		const mathjaxStyleEl = this.getMathJaxStyleElement();
		if (mathjaxStyleEl) {
			this.mathjaxStyleObserver = new MutationObserver(() => this.patchStyles());
			this.mathjaxStyleObserver.observe(mathjaxStyleEl, {
				attributes: true,
			});
		}
	}

	destroy() {
		this.mathjaxStyleObserver?.disconnect();
		this.mathjaxStyleObserver = undefined;
		this.arabicShapingObserver?.disconnect();
		this.arabicShapingObserver = undefined;
		if (this.logicalSheet) {
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
				sheet => sheet !== this.logicalSheet
			);
			this.logicalSheet = undefined;
		}
	}

	/**
	 * The mirrored rules depend on MathJax's generated stylesheet, so they
	 * can't live in styles.css; a constructed stylesheet (no <style> element)
	 * carries them instead.
	 */
	private patchStyles() {
		const rules = this.convertMathJaxStylesToLogicalProperties();
		if (!this.logicalSheet) {
			this.logicalSheet = new CSSStyleSheet();
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.logicalSheet];
		}
		this.logicalSheet.replaceSync(rules.join('\n'));
	}

	private getMathJaxStyleElement() {
		return document.getElementById('MJX-CHTML-styles') as HTMLStyleElement | null;
	}

	private convertMathJaxStylesToLogicalProperties(): string[] {
		const rules: string[] = [];
		const styleEl = this.getMathJaxStyleElement();

		if (!styleEl || !styleEl.sheet) return rules;

		for (const rule of Array.from(styleEl.sheet.cssRules)) {
			if (!(rule instanceof CSSStyleRule)) continue;

			const styleLines: string[] = [];

			const paddingLeft = rule.style.getPropertyValue('padding-left');
			const paddingRight = rule.style.getPropertyValue('padding-right');
			const marginLeft = rule.style.getPropertyValue('margin-left');
			const marginRight = rule.style.getPropertyValue('margin-right');

			if (paddingLeft) styleLines.push(`padding-inline-start: ${paddingLeft};`);
			if (paddingRight) styleLines.push(`padding-inline-end: ${paddingRight};`);
			if (marginLeft) styleLines.push(`margin-inline-start: ${marginLeft};`);
			if (marginRight) styleLines.push(`margin-inline-end: ${marginRight};`);

			if (styleLines.length > 0) {
				const newRule = `${rule.selectorText} {\n  ${styleLines.join('\n  ')}\n}`;
				rules.push(newRule);
			}
		}

		return rules;
	}
}
