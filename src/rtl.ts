import { finishRenderMath, loadMathJax } from 'obsidian';

declare global {
	interface Window {
		MathJax: any;
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
 * CSS assigning the configured fonts to Hebrew/Arabic text inside math.
 * MathJax renders characters missing from its own math fonts (e.g. Hebrew and
 * Arabic letters) as `mjx-utext` elements, so targeting those changes only
 * non-Latin text. Both fonts go into one stack: the browser picks the first
 * font that actually contains each glyph, so Hebrew letters use the Hebrew
 * font and Arabic letters fall through to the Arabic one.
 */
export function buildRtlFontCss(hebrewFont: string, arabicFont: string): string {
	const stack = [hebrewFont, arabicFont]
		.map(font => font.trim().replace(/["\\]/g, ''))
		.filter(Boolean)
		.map(font => `"${font}"`)
		.join(', ');
	if (!stack) return '';
	return `mjx-container mjx-utext {\n\tfont-family: ${stack} !important;\n}`;
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
	private styleEl?: HTMLStyleElement;

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
					if (!(node instanceof HTMLElement)) continue;
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
		this.styleEl?.remove();
		this.styleEl = undefined;
	}

	private patchStyles() {
		const rules = this.convertMathJaxStylesToLogicalProperties();
		this.styleEl?.remove();
		this.styleEl = document.head.createEl('style', {
			text: rules.join('\n')
		});
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
