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

// Variables conventionally used for angles: a result is only formatted in
// degrees when it comes from inverse trig AND the left-hand side starts with
// one of these (e.g. \theta_{c}) — computing r=\sin^{-1}(...) stays plain.
export const DEFAULT_ANGLE_NAMES = [
	'theta', 'vartheta', 'phi', 'varphi', 'alpha', 'beta', 'gamma', 'delta', 'psi',
];

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAngleName(lhs: string, angleNames: string[]): boolean {
	const s = lhs.trim();
	for (const raw of angleNames) {
		const name = raw.trim().replace(/^\\/, '');
		if (!name) continue;
		if (new RegExp(`^\\\\?${escapeRegex(name)}(?![A-Za-z])`).test(s)) return true;
	}
	return false;
}

// f^{-1} notation: \sin^{-1}(x) means arcsin, not 1/sin(x)
const INVERSE_FUNCTIONS: Record<string, (x: number) => number> = {
	sin: Math.asin, cos: Math.acos, tan: Math.atan,
	arcsin: Math.sin, arccos: Math.cos, arctan: Math.tan,
	sinh: Math.asinh, cosh: Math.acosh, tanh: Math.atanh,
	ln: Math.exp, exp: Math.log,
	log: (x: number) => Math.pow(10, x),
};

type Tok =
	| { t: 'num'; v: number }
	| { t: 'cmd'; v: string }
	| { t: 'ch'; v: string };

export interface LatexEvalResult {
	value: number;
	/** true when the outermost operation was an inverse trig function, i.e. the value is an angle in radians */
	isAngle: boolean;
}

/** Numerically evaluate a LaTeX expression; null if it isn't a closed-form number. */
export function evaluateLatex(latex: string): number | null {
	return evaluateLatexResult(latex)?.value ?? null;
}

/** Normalize a LaTeX expression and split it into tokens; null if it contains anything foreign. */
function tokenize(latex: string): Tok[] | null {
	const src = latex
		.replace(/\\left\b|\\right\b/g, ' ')
		.replace(/\\[,:;!]|\\ /g, ' ')
		.replace(/~/g, ' ')
		.replace(/\\cdot\b|\\times\b/g, '*')
		.replace(/\\div\b/g, '/')
		.replace(/\\[cdt]frac\b/g, '\\frac')
		// Unicode math characters (typically from pasted text):
		// multiplication signs, minus signs/dashes, division sign, pi
		.replace(/[×·⋅∙]/g, '*')
		.replace(/[−–]/g, '-')
		.replace(/÷/g, '/')
		.replace(/π/g, '\\pi ');

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
	return toks;
}

/** Like {@link evaluateLatex}, but also reports whether the result is an angle. */
export function evaluateLatexResult(latex: string): LatexEvalResult | null {
	const toks = tokenize(latex);
	if (!toks || toks.length === 0) return null;

	let p = 0;
	// value produced by the most recent inverse-trig call; if the final result
	// equals it, the outermost operation was that call and the result is an angle
	let angleResult: number | null = null;
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
				// degrees: 49.20^\circ or 49.20^{\circ} converts to radians
				const et = peek();
				if (et && et.t === 'cmd' && et.v === 'circ') {
					p++;
					base = base * (Math.PI / 180);
					continue;
				}
				const t1 = toks[p + 1];
				const t2 = toks[p + 2];
				if (et && et.t === 'ch' && et.v === '{'
					&& t1 && t1.t === 'cmd' && t1.v === 'circ'
					&& t2 && t2.t === 'ch' && t2.v === '}') {
					p += 3;
					base = base * (Math.PI / 180);
					continue;
				}
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
			if (t.v in FUNCTIONS) {
				// an exponent directly on the function: \sin^{-1} x (inverse)
				// or \sin^{2} x, which conventionally means (sin x)^2
				let power: number | null = null;
				const nt = peek();
				if (nt && nt.t === 'ch' && nt.v === '^') {
					p++;
					const et = peek();
					power = (et && et.t === 'ch' && (et.v === '-' || et.v === '+')) ? parseUnary() : parseAtom();
				}
				if (power === -1) {
					const inverse = INVERSE_FUNCTIONS[t.v];
					if (!inverse) fail();
					const inverted = inverse(parseUnary());
					if (t.v === 'sin' || t.v === 'cos' || t.v === 'tan') angleResult = inverted;
					return inverted;
				}
				const value = FUNCTIONS[t.v](parseUnary());
				if (power === null) {
					if (t.v === 'arcsin' || t.v === 'arccos' || t.v === 'arctan') angleResult = value;
					return value;
				}
				return Math.pow(value, power);
			}
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
		if (!isFinite(value)) return null;
		return { value, isAngle: angleResult !== null && value === angleResult };
	} catch {
		return null;
	}
}

/* ---------- polynomial (quadratic) solving ---------- */

const KNOWN_COMMANDS = new Set(['frac', 'sqrt', 'pi', 'circ', ...Object.keys(FUNCTIONS)]);

/** Coefficients, lowest power first: [c, b, a] is a·v² + b·v + c. */
type Poly = number[];

const polyTrim = (a: Poly): Poly => {
	const r = [...a];
	while (r.length > 1 && r[r.length - 1] === 0) r.pop();
	return r;
};
const polyIsConst = (a: Poly): boolean => polyTrim(a).length === 1;
const polyConst = (a: Poly): number => polyTrim(a)[0];
const polyAdd = (a: Poly, b: Poly): Poly => {
	const r: Poly = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) r.push((a[i] ?? 0) + (b[i] ?? 0));
	return r;
};
const polyNeg = (a: Poly): Poly => a.map(c => -c);
const polySub = (a: Poly, b: Poly): Poly => polyAdd(a, polyNeg(b));
const polyMul = (a: Poly, b: Poly): Poly => {
	const r: Poly = new Array<number>(a.length + b.length - 1).fill(0);
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j];
	}
	return r;
};

interface PolyResult {
	poly: Poly;
	/** the unknown as it appears in LaTeX ("x" or "\theta"); null if the expression is constant */
	variable: string | null;
}

/**
 * Evaluate a LaTeX expression as a polynomial in a single unknown. The
 * unknown is whatever letter (except e) or non-math command appears; more
 * than one distinct symbol means this isn't a solvable single-unknown
 * polynomial and null is returned.
 */
export function evaluatePolynomial(latex: string): PolyResult | null {
	const toks = tokenize(latex);
	if (!toks || toks.length === 0) return null;

	const candidates = new Set<string>();
	for (const t of toks) {
		if (t.t === 'ch' && /[A-Za-z]/.test(t.v) && t.v !== 'e') candidates.add(t.v);
		else if (t.t === 'cmd' && !KNOWN_COMMANDS.has(t.v)) candidates.add('\\' + t.v);
	}
	if (candidates.size > 1) return null;
	const variable: string | null = candidates.size === 1 ? [...candidates][0] : null;

	let p = 0;
	const fail = (): never => { throw new Error('unparseable'); };
	const peek = () => toks[p];
	const expectCh = (ch: string) => {
		const t = peek();
		if (!t || t.t !== 'ch' || t.v !== ch) fail();
		p++;
	};

	const parseExpr = (): Poly => {
		let v = parseTerm();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && (t.v === '+' || t.v === '-')) {
				p++;
				const rhs = parseTerm();
				v = t.v === '+' ? polyAdd(v, rhs) : polySub(v, rhs);
			} else break;
		}
		return v;
	};

	const startsFactor = (t: Tok | undefined): boolean => {
		if (!t) return false;
		if (t.t === 'num') return true;
		if (t.t === 'cmd') return true;
		return t.v === '(' || t.v === '{' || /[A-Za-z]/.test(t.v);
	};

	const parseTerm = (): Poly => {
		let v = parseUnary();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && (t.v === '*' || t.v === '/')) {
				p++;
				const rhs = parseUnary();
				if (t.v === '*') {
					v = polyMul(v, rhs);
				} else {
					if (!polyIsConst(rhs) || polyConst(rhs) === 0) fail();
					v = v.map(c => c / polyConst(rhs));
				}
			} else if (startsFactor(t)) {
				v = polyMul(v, parseUnary());
			} else break;
		}
		return v;
	};

	const parseUnary = (): Poly => {
		const t = peek();
		if (t && t.t === 'ch' && (t.v === '-' || t.v === '+')) {
			p++;
			const v = parseUnary();
			return t.v === '-' ? polyNeg(v) : v;
		}
		return parsePow();
	};

	const parsePow = (): Poly => {
		let base = parseAtom();
		for (;;) {
			const t = peek();
			if (t && t.t === 'ch' && t.v === '^') {
				p++;
				const et = peek();
				if (et && et.t === 'cmd' && et.v === 'circ') {
					p++;
					if (!polyIsConst(base)) fail();
					base = [polyConst(base) * (Math.PI / 180)];
					continue;
				}
				const t1 = toks[p + 1];
				const t2 = toks[p + 2];
				if (et && et.t === 'ch' && et.v === '{'
					&& t1 && t1.t === 'cmd' && t1.v === 'circ'
					&& t2 && t2.t === 'ch' && t2.v === '}') {
					p += 3;
					if (!polyIsConst(base)) fail();
					base = [polyConst(base) * (Math.PI / 180)];
					continue;
				}
				const exp = (et && et.t === 'ch' && (et.v === '-' || et.v === '+')) ? parseUnary() : parseAtom();
				if (!polyIsConst(exp)) fail();
				const e = polyConst(exp);
				if (polyIsConst(base)) {
					base = [Math.pow(polyConst(base), e)];
				} else {
					if (!Number.isInteger(e) || e < 0 || e > 6) fail();
					let r: Poly = [1];
					for (let k = 0; k < e; k++) r = polyMul(r, base);
					base = r;
				}
			} else if (t && t.t === 'ch' && t.v === '_') {
				fail();
			} else break;
		}
		return base;
	};

	const parseBraced = (): Poly => {
		expectCh('{');
		const v = parseExpr();
		expectCh('}');
		return v;
	};

	const parseAtom = (): Poly => {
		const t = peek();
		if (!t) fail();
		if (t.t === 'num') { p++; return [t.v]; }
		if (t.t === 'cmd') {
			p++;
			if ('\\' + t.v === variable) return [0, 1];
			if (t.v === 'pi') return [Math.PI];
			if (t.v === 'frac') {
				const a = parseBraced();
				const b = parseBraced();
				if (!polyIsConst(b) || polyConst(b) === 0) fail();
				return a.map(c => c / polyConst(b));
			}
			if (t.v === 'sqrt') {
				let n = 2;
				const nt = peek();
				if (nt && nt.t === 'ch' && nt.v === '[') {
					p++;
					const nPoly = parseExpr();
					expectCh(']');
					if (!polyIsConst(nPoly)) fail();
					n = polyConst(nPoly);
				}
				const arg = parseBraced();
				if (!polyIsConst(arg)) fail();
				return [Math.pow(polyConst(arg), 1 / n)];
			}
			if (t.v in FUNCTIONS) {
				const arg = parseUnary();
				if (!polyIsConst(arg)) fail();
				return [FUNCTIONS[t.v](polyConst(arg))];
			}
			return fail();
		}
		if (t.t === 'ch') {
			if (t.v === '(') { p++; const v = parseExpr(); expectCh(')'); return v; }
			if (t.v === '{') { p++; const v = parseExpr(); expectCh('}'); return v; }
			if (t.v === variable) { p++; return [0, 1]; }
			if (t.v === 'e') { p++; return [Math.E]; }
		}
		return fail();
	};

	try {
		const poly = polyTrim(parseExpr());
		if (p !== toks.length) return null;
		if (!poly.every(isFinite)) return null;
		return { poly, variable };
	} catch {
		return null;
	}
}

/**
 * Solve "lhs = rhs" (or "expr = 0" when lhs is empty) as a linear or
 * quadratic equation in a single unknown. Returns the insertion text with
 * both solutions — complex ones as "p \pm q i" — or null when the input
 * isn't such an equation (the numeric path then takes over). A plain
 * assignment like "x = 3" is deliberately left to the numeric path.
 */
function tryPolynomialSolve(lhs: string, rhs: string, separator: string): string | null {
	const right = evaluatePolynomial(rhs);
	if (!right) return null;

	let combined: Poly;
	let variable: string | null;
	if (lhs) {
		const left = evaluatePolynomial(lhs);
		if (!left) return null;
		if (left.variable && right.variable && left.variable !== right.variable) return null;
		variable = left.variable ?? right.variable;
		const bareUnknown = left.poly.length === 2 && left.poly[0] === 0 && left.poly[1] === 1;
		if (left.variable && bareUnknown && !right.variable) return null;
		combined = polySub(left.poly, right.poly);
	} else {
		variable = right.variable;
		combined = right.poly;
	}
	if (!variable) return null;

	combined = polyTrim(combined);
	const sep = separator.trim();
	const prefix = ` ${sep ? sep + ' ' : ''}`;

	if (combined.length === 3) {
		const [c, b, a] = combined;
		const discriminant = b * b - 4 * a * c;
		const tolerance = 1e-12 * Math.max(Math.abs(b * b), Math.abs(4 * a * c), 1);

		if (Math.abs(discriminant) <= tolerance) {
			return `${prefix}${variable}_{1,2}=${formatValue(-b / (2 * a))}`;
		}
		if (discriminant > 0) {
			const r1 = (-b + Math.sqrt(discriminant)) / (2 * a);
			const r2 = (-b - Math.sqrt(discriminant)) / (2 * a);
			return `${prefix}${variable}_1=${formatValue(r1)},\\ ${variable}_2=${formatValue(r2)}`;
		}
		const re = -b / (2 * a);
		const im = Math.abs(Math.sqrt(-discriminant) / (2 * a));
		const reStr = formatValue(re) === '0' ? '' : formatValue(re);
		const imStr = formatValue(im) === '1' ? 'i' : `${formatValue(im)}i`;
		return `${prefix}${variable}_{1,2}=${reStr}\\pm ${imStr}`;
	}
	if (combined.length === 2) {
		return `${prefix}${variable}=${formatValue(-combined[0] / combined[1])}`;
	}
	return null;
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

/**
 * Positions of equation separators ("=", "\approx", "\simeq") at brace/paren
 * depth 0, skipping other LaTeX commands. Each match reports its length so
 * the right-hand side can be sliced after multi-character separators.
 */
function findTopLevelEquals(segment: string): { index: number; length: number }[] {
	const positions: { index: number; length: number }[] = [];
	let depth = 0;
	let i = 0;
	while (i < segment.length) {
		const c = segment[i];
		if (c === '\\') {
			let j = i + 1;
			while (j < segment.length && /[a-zA-Z]/.test(segment[j])) j++;
			const name = segment.slice(i + 1, j);
			if (depth === 0 && (name === 'approx' || name === 'simeq')) {
				positions.push({ index: i, length: j - i });
			}
			i = j === i + 1 ? i + 2 : j;
			continue;
		}
		if (c === '{' || c === '(' || c === '[') depth++;
		else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
		else if (depth === 0 && c === '=') positions.push({ index: i, length: 1 });
		i++;
	}
	return positions;
}

/** Round to 6 significant digits; large/small values become m\cdot 10^{n}. */
export function formatValue(v: number): string {
	if (v === 0) return '0';
	// relative tolerance only: a tiny value like 1.62e-15 is a real result,
	// not a float-noise integer, and must never snap to 0
	const rounded = Math.round(v);
	if (rounded !== 0 && Math.abs(v - rounded) <= 1e-9 * Math.abs(rounded)) return String(rounded);
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
export function computeSolveInsertion(
	mathContent: string,
	separator: string,
	angleUnit: 'degrees' | 'radians' = 'degrees',
	angleNames: string[] = DEFAULT_ANGLE_NAMES,
): string | null {
	const content = mathContent.replace(/\\displaystyle\b/g, ' ');
	const segments = splitTopLevelSegments(content).map(s => s.trim()).filter(Boolean);
	if (segments.length === 0) return null;

	let lhs = '';
	let rhs = '';
	for (let i = segments.length - 1; i >= 0; i--) {
		const equals = findTopLevelEquals(segments[i]);
		if (equals.length > 0) {
			const last = equals[equals.length - 1];
			lhs = segments[i].slice(0, equals[0].index).trim();
			rhs = segments[i].slice(last.index + last.length).trim();
			break;
		}
	}
	if (!rhs) {
		rhs = segments[segments.length - 1];
	}

	// quadratic/linear equation in an unknown ("x^2+2x+1", "x^2+2x=-1")
	const polySolution = tryPolynomialSolve(lhs, rhs, separator);
	if (polySolution !== null) return polySolution;

	let unit = '';
	const unitMatch = rhs.match(/^([\s\S]*?)(?:\\ |\s)*\\(mathrm|text)\{([^{}]*)\}\s*$/);
	if (unitMatch) {
		rhs = unitMatch[1].trim();
		unit = `\\ \\${unitMatch[2]}{${unitMatch[3]}}`;
	}
	if (!rhs) return null;

	// "lhs = value" output only makes sense when lhs is a name (k_1, \theta_{c})
	// or itself a number — not for leftovers like "x^3+1=0" that the
	// polynomial path rejected
	const NAME_RE = /^\\?[A-Za-z]+(?:_(?:\{[\s\S]*\}|[A-Za-z0-9]))?$/;
	if (lhs && !NAME_RE.test(lhs.trim()) && evaluateLatexResult(lhs) === null) return null;

	const result = evaluateLatexResult(rhs);
	if (result === null) return null;
	const isAngle = result.isAngle && (lhs === '' || isAngleName(lhs, angleNames));
	const formatted = isAngle && angleUnit === 'degrees'
		? formatValue(result.value * 180 / Math.PI) + '^\\circ'
		: formatValue(result.value);

	if (lhs) {
		const sep = separator.trim();
		return ` ${sep ? sep + ' ' : ''}${lhs}=${formatted}${unit}`;
	}
	return `=${formatted}${unit}`;
}
