/**
 * Pure parsing/serialization for the `\forminput[...]` command.
 *
 * `\forminput` is a plugin-specific command deliberately named so it never
 * shadows LaTeX's own `\input{file}`. Keeping this module free of DOM and
 * Obsidian imports makes the whole parsing/validation layer unit-testable;
 * `forminput.ts` holds everything that touches the document or the screen.
 */

export const FORM_INPUT_COMMAND = 'forminput';

export const MIN_FIELD_WIDTH = 40;
export const MAX_FIELD_WIDTH = 1200;
export const DEFAULT_FIELD_WIDTH = 220;

export interface FormFieldSpec {
	/** stable key the entered value is stored under */
	id: string;
	label: string;
	placeholder: string;
	/** value used when nothing has been entered yet */
	defaultValue: string;
	/** pixel width; null means "use the stylesheet default" */
	width: number | null;
	required: boolean;
	multiline: boolean;
}

export interface FormFieldMatch {
	/** offset of the leading backslash */
	start: number;
	/** offset just past the closing "]" */
	end: number;
	spec: FormFieldSpec;
}

/** Options accepted by the insert dialog, all optional. */
export type FormFieldOptions = Partial<Omit<FormFieldSpec, 'id'>> & { id?: string };

function emptySpec(): FormFieldSpec {
	return {
		id: '',
		label: '',
		placeholder: '',
		defaultValue: '',
		width: null,
		required: false,
		multiline: false,
	};
}

/** Collapse whitespace and drop control characters from a user-supplied string. */
export function sanitizeText(value: string): string {
	// eslint-disable-next-line no-control-regex -- matching control characters is the point: they are stripped from user input
	return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Make a value safe to embed inside `{...}` in the command source: control
 * characters go away and braces are balanced, so a stray "}" can never end the
 * option early and turn the rest of the note into a broken command.
 */
export function sanitizeBraceValue(value: string): string {
	const cleaned = sanitizeText(value);
	let depth = 0;
	let out = '';
	for (const ch of cleaned) {
		if (ch === '{') {
			depth++;
			out += ch;
		} else if (ch === '}') {
			if (depth === 0) continue;    // unmatched closer would end the option
			depth--;
			out += ch;
		} else {
			out += ch;
		}
	}
	return out + '}'.repeat(depth);    // close what the user left open
}

/** Normalize an id to something safe to use as a storage key. */
export function sanitizeId(value: string): string {
	return sanitizeText(value).replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/^-+|-+$/g, '');
}

function parseBoolean(value: string, fallback: boolean): boolean {
	const v = value.trim().toLowerCase();
	if (v === '') return true;    // bare "required" means required=true
	if (['true', 'yes', '1', 'on'].includes(v)) return true;
	if (['false', 'no', '0', 'off'].includes(v)) return false;
	return fallback;
}

export function clampWidth(value: number): number {
	return Math.min(MAX_FIELD_WIDTH, Math.max(MIN_FIELD_WIDTH, Math.round(value)));
}

/** Split "a=1, b={x, y}" on top-level commas only. */
function splitOptions(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '\\') { i++; continue; }
		if (ch === '{') depth++;
		else if (ch === '}') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts.map(p => p.trim()).filter(p => p.length > 0);
}

function unwrapBraces(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** Parse the inside of `\forminput[...]` into a spec. */
export function parseFormFieldOptions(body: string): FormFieldSpec {
	const spec = emptySpec();

	for (const part of splitOptions(body)) {
		const eq = part.indexOf('=');
		const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
		const rawValue = eq === -1 ? '' : part.slice(eq + 1);

		switch (key) {
			case 'id':
				spec.id = sanitizeId(unwrapBraces(rawValue));
				break;
			case 'label':
				spec.label = sanitizeText(unwrapBraces(rawValue));
				break;
			case 'placeholder':
				spec.placeholder = sanitizeText(unwrapBraces(rawValue));
				break;
			case 'default':
			case 'value':
				spec.defaultValue = sanitizeText(unwrapBraces(rawValue));
				break;
			case 'width': {
				const n = parseFloat(unwrapBraces(rawValue));
				spec.width = Number.isFinite(n) ? clampWidth(n) : null;
				break;
			}
			case 'required':
				spec.required = parseBoolean(unwrapBraces(rawValue), true);
				break;
			case 'multiline':
				spec.multiline = parseBoolean(unwrapBraces(rawValue), true);
				break;
			default:
				break;    // unknown options are ignored, not an error
		}
	}

	return spec;
}

/**
 * Find every `\forminput[...]` in `text`. The closing bracket is located with a
 * brace-aware scan so labels may legally contain "]" inside braces.
 *
 * A field with no `id` keeps an empty one: it still renders and can be typed
 * into, but its value is not persisted. A positional fallback id was rejected
 * because this function is also run over partial text (a viewport slice, a
 * rendered block), where positions differ and two fields could collide on the
 * same key.
 */
export function findFormFields(text: string): FormFieldMatch[] {
	const matches: FormFieldMatch[] = [];
	const needle = '\\' + FORM_INPUT_COMMAND;
	let searchFrom = 0;

	for (;;) {
		const start = text.indexOf(needle, searchFrom);
		if (start === -1) break;
		searchFrom = start + needle.length;

		// "\forminputs" must not match "\forminput"
		const after = text[start + needle.length];
		if (after !== undefined && /[A-Za-z]/.test(after)) continue;
		// an escaped "\\forminput" is literal text, not a command
		let backslashes = 0;
		for (let i = start - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
		if (backslashes % 2 === 1) continue;

		let i = start + needle.length;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (text[i] !== '[') continue;

		let depth = 0;
		let end = -1;
		for (let j = i + 1; j < text.length; j++) {
			const ch = text[j];
			if (ch === '\\') { j++; continue; }
			if (ch === '{') depth++;
			else if (ch === '}') depth = Math.max(0, depth - 1);
			else if (ch === ']' && depth === 0) { end = j; break; }
			else if (ch === '\n' && depth === 0) break;    // unterminated: not a field
		}
		if (end === -1) continue;

		matches.push({
			start,
			end: end + 1,
			spec: parseFormFieldOptions(text.slice(i + 1, end)),
		});
		searchFrom = end + 1;
	}

	return matches;
}

/** Build the command source for a spec (used by the insert dialog). */
export function serializeFormField(options: FormFieldOptions): string {
	const parts: string[] = [];
	const id = sanitizeId(options.id ?? '');
	if (id) parts.push(`id=${id}`);
	if (options.label) parts.push(`label={${sanitizeBraceValue(options.label)}}`);
	if (options.placeholder) parts.push(`placeholder={${sanitizeBraceValue(options.placeholder)}}`);
	if (options.defaultValue) parts.push(`default={${sanitizeBraceValue(options.defaultValue)}}`);
	if (typeof options.width === 'number' && Number.isFinite(options.width)) {
		parts.push(`width=${clampWidth(options.width)}`);
	}
	if (options.required) parts.push('required=true');
	if (options.multiline) parts.push('multiline=true');

	return `\\${FORM_INPUT_COMMAND}[${parts.join(', ')}]`;
}

/** A field without an id renders normally but has nowhere to save its value. */
export function isPersistable(spec: FormFieldSpec): boolean {
	return spec.id !== '';
}

/** Human-readable name for messages. */
export function fieldLabel(spec: FormFieldSpec): string {
	return spec.label || spec.id || 'Unnamed field';
}

/** The value a field should show: the stored entry, else its default. */
export function resolveFieldValue(spec: FormFieldSpec, values: Record<string, string>): string {
	if (!isPersistable(spec)) return spec.defaultValue;
	const stored = values[spec.id];
	return stored === undefined ? spec.defaultValue : stored;
}

export interface FieldValidationError {
	id: string;
	label: string;
	message: string;
}

/** Required fields whose resolved value is empty. */
export function validateFields(
	specs: FormFieldSpec[],
	values: Record<string, string>,
): FieldValidationError[] {
	const errors: FieldValidationError[] = [];
	for (const spec of specs) {
		if (!spec.required) continue;
		if (resolveFieldValue(spec, values).trim() !== '') continue;
		const label = fieldLabel(spec);
		errors.push({ id: spec.id, label, message: `"${label}" is required.` });
	}
	return errors;
}

/**
 * Replace every `\forminput[...]` with its current value as ordinary text, so
 * exported LaTeX contains no plugin-specific commands. Empty fields collapse to
 * an underline of the field's width, which is what a blank on a form looks like
 * in print.
 */
export function renderFieldsAsText(source: string, values: Record<string, string>): string {
	const matches = findFormFields(source);
	let out = '';
	let last = 0;

	for (const match of matches) {
		out += source.slice(last, match.start);
		const value = resolveFieldValue(match.spec, values).trim();
		if (value) {
			out += value;
		} else {
			const width = match.spec.width ?? DEFAULT_FIELD_WIDTH;
			out += `\\underline{\\hspace{${width}pt}}`;
		}
		last = match.end;
	}

	return out + source.slice(last);
}

/**
 * Preamble that makes `\forminput` compile in a real LaTeX toolchain, printing
 * the field's default value (or a blank rule) instead of an interactive box.
 */
export const FORM_INPUT_LATEX_PREAMBLE = [
	'% Makes \\forminput[...] compile outside Obsidian.',
	'\\usepackage{kvoptions-patch}',
	'\\usepackage{xkeyval}',
	'\\makeatletter',
	'\\define@key{forminput}{id}{}',
	'\\define@key{forminput}{label}{\\def\\fi@label{#1}}',
	'\\define@key{forminput}{placeholder}{}',
	'\\define@key{forminput}{default}{\\def\\fi@default{#1}}',
	'\\define@key{forminput}{width}{\\def\\fi@width{#1}}',
	'\\define@key{forminput}{required}[true]{}',
	'\\define@key{forminput}{multiline}[true]{}',
	'\\newcommand{\\forminput}[1][]{%',
	'  \\def\\fi@label{}\\def\\fi@default{}\\def\\fi@width{220}%',
	'  \\setkeys{forminput}{#1}%',
	'  \\ifx\\fi@label\\empty\\else\\fi@label\\ \\fi',
	'  \\ifx\\fi@default\\empty\\underline{\\hspace{\\fi@width pt}}\\else\\fi@default\\fi}',
	'\\makeatother',
].join('\n');
