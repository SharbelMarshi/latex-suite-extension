import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	DEFAULT_FIELD_WIDTH,
	MAX_FIELD_WIDTH,
	MIN_FIELD_WIDTH,
	fieldLabel,
	findFormFields,
	isPersistable,
	parseFormFieldOptions,
	renderFieldsAsText,
	resolveFieldValue,
	sanitizeBraceValue,
	sanitizeId,
	sanitizeText,
	serializeFormField,
	validateFields,
} from '../src/forminput-core';

describe('parsing \\forminput', () => {
	it('parses every supported property', () => {
		const spec = parseFormFieldOptions(
			'id=name, label={Full name}, placeholder={Enter your name}, default={Ada}, width=240, required=true, multiline=true'
		);
		assert.equal(spec.id, 'name');
		assert.equal(spec.label, 'Full name');
		assert.equal(spec.placeholder, 'Enter your name');
		assert.equal(spec.defaultValue, 'Ada');
		assert.equal(spec.width, 240);
		assert.equal(spec.required, true);
		assert.equal(spec.multiline, true);
	});

	it('defaults sensibly when properties are omitted', () => {
		const spec = parseFormFieldOptions('id=x');
		assert.equal(spec.label, '');
		assert.equal(spec.placeholder, '');
		assert.equal(spec.defaultValue, '');
		assert.equal(spec.width, null);
		assert.equal(spec.required, false);
		assert.equal(spec.multiline, false);
	});

	it('accepts bare and negative booleans', () => {
		assert.equal(parseFormFieldOptions('required').required, true);
		assert.equal(parseFormFieldOptions('required=yes').required, true);
		assert.equal(parseFormFieldOptions('required=false').required, false);
		assert.equal(parseFormFieldOptions('multiline=0').multiline, false);
	});

	it('clamps width and ignores non-numeric width', () => {
		assert.equal(parseFormFieldOptions('width=5').width, MIN_FIELD_WIDTH);
		assert.equal(parseFormFieldOptions('width=99999').width, MAX_FIELD_WIDTH);
		assert.equal(parseFormFieldOptions('width=wide').width, null);
	});

	it('keeps commas and brackets that are inside braces', () => {
		const spec = parseFormFieldOptions('label={Surname, given name [legal]}, id=n');
		assert.equal(spec.label, 'Surname, given name [legal]');
		assert.equal(spec.id, 'n');
	});

	it('ignores unknown properties instead of failing', () => {
		const spec = parseFormFieldOptions('id=a, colour=red');
		assert.equal(spec.id, 'a');
	});

	it('finds fields with their source offsets', () => {
		const source = 'Name: \\forminput[id=name] and age: \\forminput[id=age]';
		const fields = findFormFields(source);
		assert.equal(fields.length, 2);
		assert.equal(fields[0].spec.id, 'name');
		assert.equal(source.slice(fields[0].start, fields[0].end), '\\forminput[id=name]');
		assert.equal(fields[1].spec.id, 'age');
	});

	it('does not touch LaTeX\'s own \\input', () => {
		assert.deepEqual(findFormFields('\\input{chapter1.tex}'), []);
		assert.deepEqual(findFormFields('\\inputs[id=x]'), []);
	});

	it('ignores an escaped \\\\forminput', () => {
		assert.deepEqual(findFormFields('\\\\forminput[id=x]'), []);
	});

	it('ignores an unterminated field', () => {
		assert.deepEqual(findFormFields('\\forminput[id=x\nnext line]'), []);
	});

	it('leaves id-less fields without an id rather than inventing one', () => {
		const fields = findFormFields('\\forminput[label={A}] \\forminput[label={B}]');
		assert.equal(fields[0].spec.id, '');
		assert.equal(fields[1].spec.id, '');
		assert.equal(isPersistable(fields[0].spec), false);
	});

	it('finds the same field whether scanning the whole note or a slice', () => {
		const source = 'intro \\forminput[id=a] middle \\forminput[id=b] end';
		const whole = findFormFields(source).map(f => f.spec.id);
		const slice = findFormFields(source.slice(20)).map(f => f.spec.id);
		assert.deepEqual(whole, ['a', 'b']);
		assert.deepEqual(slice, ['b']);
	});
});

describe('sanitizing', () => {
	it('strips control characters and collapses whitespace', () => {
		assert.equal(sanitizeText('a\u0000b\n\nc   d'), 'a b c d');
	});

	it('balances braces so a value cannot break out of the command', () => {
		assert.equal(sanitizeBraceValue('evil} , id=other'), 'evil , id=other');
		assert.equal(sanitizeBraceValue('open {group'), 'open {group}');
		assert.equal(sanitizeBraceValue('{balanced}'), '{balanced}');
	});

	it('reduces ids to safe key characters', () => {
		assert.equal(sanitizeId('Full Name!'), 'Full-Name');
		assert.equal(sanitizeId('  --  '), '');
	});

	it('round-trips through serialize and parse', () => {
		const command = serializeFormField({
			id: 'name',
			label: 'Full name',
			placeholder: 'Enter your name',
			width: 240,
			required: true,
		});
		assert.equal(command, '\\forminput[id=name, label={Full name}, placeholder={Enter your name}, width=240, required=true]');

		const fields = findFormFields(command);
		assert.equal(fields.length, 1);
		assert.equal(fields[0].spec.label, 'Full name');
		assert.equal(fields[0].spec.required, true);
	});

	it('serializes a hostile label without breaking the command', () => {
		const command = serializeFormField({ id: 'a', label: 'x} , required=true, label={y' });
		const spec = findFormFields(command)[0].spec;
		assert.equal(spec.required, false);        // the injected option did not take effect
		assert.equal(spec.id, 'a');
	});
});

describe('values and validation', () => {
	it('prefers a stored value over the default', () => {
		const spec = parseFormFieldOptions('id=name, default={Ada}');
		assert.equal(resolveFieldValue(spec, {}), 'Ada');
		assert.equal(resolveFieldValue(spec, { name: 'Grace' }), 'Grace');
		assert.equal(resolveFieldValue(spec, { name: '' }), '');
	});

	it('reports required fields that are empty', () => {
		const specs = findFormFields(
			'\\forminput[id=name, label={Full name}, required=true] \\forminput[id=note]'
		).map(f => f.spec);

		const errors = validateFields(specs, {});
		assert.equal(errors.length, 1);
		assert.equal(errors[0].id, 'name');
		assert.match(errors[0].message, /required/);

		assert.deepEqual(validateFields(specs, { name: 'Ada' }), []);
	});

	it('treats a whitespace-only value as empty', () => {
		const specs = [parseFormFieldOptions('id=a, required=true')];
		assert.equal(validateFields(specs, { a: '   ' }).length, 1);
	});

	it('counts a required field with a default as filled', () => {
		const specs = [parseFormFieldOptions('id=a, required=true, default={x}')];
		assert.deepEqual(validateFields(specs, {}), []);
	});

	it('an id-less field shows its default and stores nothing', () => {
		const spec = parseFormFieldOptions('label={Note}, default={hello}');
		assert.equal(isPersistable(spec), false);
		// a stray stored entry under the empty key must not leak into it
		assert.equal(resolveFieldValue(spec, { '': 'leaked' }), 'hello');
	});

	it('names a field for messages, falling back sensibly', () => {
		assert.equal(fieldLabel(parseFormFieldOptions('id=a, label={Full name}')), 'Full name');
		assert.equal(fieldLabel(parseFormFieldOptions('id=a')), 'a');
		assert.equal(fieldLabel(parseFormFieldOptions('')), 'Unnamed field');
	});
});

describe('export', () => {
	it('replaces fields with their current values as ordinary text', () => {
		const source = 'Name: \\forminput[id=name, label={Full name}] (signed)';
		assert.equal(renderFieldsAsText(source, { name: 'Ada Lovelace' }), 'Name: Ada Lovelace (signed)');
	});

	it('falls back to the default value', () => {
		const source = '\\forminput[id=a, default={fallback}]';
		assert.equal(renderFieldsAsText(source, {}), 'fallback');
	});

	it('leaves an underline where an empty field was', () => {
		const source = '\\forminput[id=a, width=100]';
		assert.equal(renderFieldsAsText(source, {}), '\\underline{\\hspace{100pt}}');
		assert.equal(
			renderFieldsAsText('\\forminput[id=a]', {}),
			`\\underline{\\hspace{${DEFAULT_FIELD_WIDTH}pt}}`
		);
	});

	it('leaves the rest of the document untouched', () => {
		const source = 'Before $x^2$ \\input{other.tex} \\forminput[id=a] after';
		assert.equal(
			renderFieldsAsText(source, { a: 'v' }),
			'Before $x^2$ \\input{other.tex} v after'
		);
	});
});
