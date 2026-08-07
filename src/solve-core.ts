/**
 * Pure logic for the \solve feature: parse an equation chain, numerically
 * evaluate the expression after its last top-level "=", and build the result
 * snippet. No Obsidian/editor imports so it stays unit-testable.
 */

// Commands that separate steps of a derivation; \solve only looks at the
// last step, so lines like "... \quad \xrightarrow{} \quad C_1=0" are safe.
const SEPARATOR_COMMANDS = new Set([
	'quad', 'qquad', 'implies', 'impliedby', 'iff',
	'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'Longrightarrow', 'Longleftarrow',
	'rightarrow', 'leftarrow', 'leftrightarrow', 'longrightarrow',
	'to', 'mapsto', 'xrightarrow', 'xleftarrow',
]);

const FUNCTIONS: Record<string, (x: number) => number> = {
	sin: Math.sin, cos: Math.cos, tan: Math.tan,
	arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
	sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
	ln: Math.log, log: Math.log10, exp: Math.exp,
};

type Tok =
	| { t: 'num'; v: number }
	| { t: 'cmd'; v: string }
	| { t: 'ch'; v: string };

/** Numerically evaluate a LaTeX expression; null if it isn't a closed-form number. */
export function evaluateLatex(latex: string): number | null {
	const src = latex
		.replace(/\\left\b|\\right\b/g, ' ')
		.replace(/\\[,:;!]|\\ /g, ' ')
		.replace(/~/g, ' ')
		.replace(/\\cdot\b|\\times\b/g, '*')
		.replace(/\\div\b/g, '/')
		.replace(/\\[dt]frac\b/g, '\\frac');

	const toks: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) { i++; continue; }
		if (/[0-9.]/.test(c)) {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j])) j++;
			const num = parseFloat(src.slice(i, j));
			if (isNaN(num)) return null;
			toks.push({ t: 'num', v: num });
			i = j;
			continue;
		}
		if (c === '\\') {
			let j = i + 1;
			while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
			if (j === i + 1) return null;
			toks.push({ t: 'cmd', v: src.slice(i + 1, j) });
			i = j;
			continue;
		}
		if (/[a-zA-Z]/.test(c) || '{}()[]^+-*/_'.includes(c)) {
			toks.push({ t: 'ch', v: c });
			i++;
			continue;
		}
		return null;
	}
	if (toks.length === 0) return null;

	let p = 0;
	const fail = (): never => { throw new Error('unparseable'); };
	const peek = () => toks[p];
	const expectCh = (ch: string) => {
		const t = peek();
		if (!t || t.t !== 'ch' || t.v !== ch) fail();
		p++;
	};

	const parseExpr = (): number => {
		let v = parseTerm();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && (t.v === '+' || t.v === '-')) {
				p++;
				const rhs = parseTerm();
				v = t.v === '+' ? v + rhs : v - rhs;
			} else break;
		}
		return v;
	};

	const startsFactor = (t: Tok | undefined): boolean => {
		if (!t) return false;
		if (t.t === 'num') return true;
		if (t.t === 'cmd') return t.v === 'frac' || t.v === 'sqrt' || t.v === 'pi' || t.v in FUNCTIONS;
		return t.v === '(' || t.v === '{' || /[a-zA-Z]/.test(t.v);
	};

	const parseTerm = (): number => {
		let v = parseUnary();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && (t.v === '*' || t.v === '/')) {
				p++;
				const rhs = parseUnary();
				v = t.v === '*' ? v * rhs : v / rhs;
			} else if (startsFactor(t)) {
				v = v * parseUnary();    // implicit multiplication: 2\pi, 3(4)
			} else break;
		}
		return v;
	};

	const parseUnary = (): number => {
		const t = peek();
		if (t && t.t === 'ch' && (t.v === '-' || t.v === '+')) {
			p++;
			const v = parseUnary();
			return t.v === '-' ? -v : v;
		}
		return parsePow();
	};

	const parsePow = (): number => {
		let base = parseAtom();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && t.v === '^') {
				p++;
				const et = peek();
				const exp = (et && et.t === 'ch' && (et.v === '-' || et.v === '+')) ? parseUnary() : parseAtom();
				base = Math.pow(base, exp);
			} else if (t && t.t === 'ch' && t.v === '_') {
				fail();    // subscripted symbols are variables, not numbers
			} else break;
		}
		return base;
	};

	const parseBraced = (): number => {
		expectCh('{');
		const v = parseExpr();
		expectCh('}');
		return v;
	};

	const parseAtom = (): number => {
		const t = peek();
		if (!t) fail();
		if (t.t === 'num') { p++; return t.v; }
		if (t.t === 'cmd') {
			p++;
			if (t.v === 'pi') return Math.PI;
			if (t.v === 'frac') {
				const a = parseBraced();
				const b = parseBraced();
				return a / b;
			}
			if (t.v === 'sqrt') {
				let n = 2;
				const nt = peek();
				if (nt && nt.t === 'ch' && nt.v === '[') {
					p++;
					n = parseExpr();
					expectCh(']');
				}
				return Math.pow(parseBraced(), 1 / n);
			}
			if (t.v in FUNCTIONS) return FUNCTIONS[t.v](parseUnary());
			fail();
		}
		if (t.t === 'ch') {
			if (t.v === '(') { p++; const v = parseExpr(); expectCh(')'); return v; }
			if (t.v === '{') { p++; const v = parseExpr(); expectCh('}'); return v; }
			if (t.v === 'e') { p++; return Math.E; }
		}
		return fail();
	};

	try {
		const value = parseExpr();
		if (p !== toks.length) return null;
		return isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** Skip balanced {...} / [...] groups (e.g. the arguments of \xrightarrow). */
function skipGroups(s: string, i: number): number {
	for (;;) {
		let j = i;
		while (j < s.length && /\s/.test(s[j])) j++;
		const open = s[j];
		if (open !== '{' && open !== '[') return i;
		const close = open === '{' ? '}' : ']';
		let depth = 0;
		while (j < s.length) {
			if (s[j] === '\\') { j += 2; continue; }
			if (s[j] === open) depth++;
			else if (s[j] === close) {
				depth--;
				if (depth === 0) { j++; break; }
			}
			j++;
		}
		i = j;
	}
}

/** Split at top-level separator commands and commas/semicolons. */
function splitTopLevelSegments(content: string): string[] {
	const segments: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	while (i < content.length) {
		const c = content[i];
		if (c === '\\') {
			let j = i + 1;
			while (j < content.length && /[a-zA-Z]/.test(content[j])) j++;
			const name = content.slice(i + 1, j);
			if (depth === 0 && SEPARATOR_COMMANDS.has(name)) {
				segments.push(content.slice(start, i));
				start = i = skipGroups(content, j);
				continue;
			}
			i = name ? j : i + 2;
			continue;
		}
		if (c === '{' || c === '(' || c === '[') depth++;
		else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
		else if (depth === 0 && (c === ',' || c === ';')) {
			segments.push(content.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	segments.push(content.slice(start));
	return segments;
}

/** Indices of a character at brace/paren depth 0, skipping LaTeX commands. */
function findTopLevel(segment: string, ch: string): number[] {
	const positions: number[] = [];
	let depth = 0;
	let i = 0;
	while (i < segment.length) {
		const c = segment[i];
		if (c === '\\') {
			let j = i + 1;
			while (j < segment.length && /[a-zA-Z]/.test(segment[j])) j++;
			i = j === i + 1 ? i + 2 : j;
			continue;
		}
		if (c === '{' || c === '(' || c === '[') depth++;
		else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
		else if (depth === 0 && c === ch) positions.push(i);
		i++;
	}
	return positions;
}

/** Round to 6 significant digits; large/small values become m\cdot 10^{n}. */
export function formatValue(v: number): string {
	const rounded = Math.round(v);
	if (Math.abs(v - rounded) <= 1e-9 * Math.max(1, Math.abs(v))) return String(rounded);
	const s = v.toPrecision(6);
	if (!s.includes('e')) {
		return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
	}
	const [mantissa, exponent] = s.split('e');
	const m = mantissa.replace(/0+$/, '').replace(/\.$/, '');
	return `${m}\\cdot 10^{${parseInt(exponent, 10)}}`;
}

/**
 * Given the math source before "\solve", produce the text to insert in its
 * place (e.g. " \quad \xrightarrow{} \quad k_1=5\ \mathrm{rad/m}"), or null
 * if the last equation can't be evaluated. The equation chain's first "="
 * gives the left-hand side to repeat; the last "=" gives the expression to
 * evaluate. A trailing \mathrm{...} or \text{...} is carried over as a unit.
 */
export function computeSolveInsertion(mathContent: string, separator: string): string | null {
	const content = mathContent.replace(/\\displaystyle\b/g, ' ');
	const segments = splitTopLevelSegments(content).map(s => s.trim()).filter(Boolean);
	if (segments.length === 0) return null;

	let lhs = '';
	let rhs = '';
	for (let i = segments.length - 1; i >= 0; i--) {
		const equals = findTopLevel(segments[i], '=');
		if (equals.length > 0) {
			lhs = segments[i].slice(0, equals[0]).trim();
			rhs = segments[i].slice(equals[equals.length - 1] + 1).trim();
			break;
		}
	}
	if (!rhs) {
		rhs = segments[segments.length - 1];
	}

	let unit = '';
	const unitMatch = rhs.match(/^([\s\S]*?)(?:\\ |\s)*\\(mathrm|text)\{([^{}]*)\}\s*$/);
	if (unitMatch) {
		rhs = unitMatch[1].trim();
		unit = `\\ \\${unitMatch[2]}{${unitMatch[3]}}`;
	}
	if (!rhs) return null;

	const value = evaluateLatex(rhs);
	if (value === null) return null;
	const formatted = formatValue(value);

	if (lhs) {
		const sep = separator.trim();
		return ` ${sep ? sep + ' ' : ''}${lhs}=${formatted}${unit}`;
	}
	return `=${formatted}${unit}`;
}
