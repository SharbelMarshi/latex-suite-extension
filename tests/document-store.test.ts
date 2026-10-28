import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DocumentStore, SAVE_DEBOUNCE_MS, parseDocuments } from '../src/document-store';
import { createAnnotation, findOccurrences } from '../src/annotations-core';

const NOTE = 'notes/physics.md';

function makeStore() {
	let saves = 0;
	const store = new DocumentStore(() => { saves++; });
	return { store, saves: () => saves };
}

function sampleAnnotation(source = 'the cat sat', text = 'cat', id = 'm1') {
	return createAnnotation({
		source,
		start: findOccurrences(source, text)[0],
		text,
		meaning: 'a small feline',
		id,
		createdAt: 1,
	});
}

describe('field values', () => {
	it('stores and reads a value per note', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		assert.equal(store.getValue(NOTE, 'name'), 'Ada');
		assert.deepEqual(store.getValues(NOTE), { name: 'Ada' });
	});

	it('keeps notes separate', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		store.setValue('other.md', 'name', 'Grace');
		assert.equal(store.getValue(NOTE, 'name'), 'Ada');
		assert.equal(store.getValue('other.md', 'name'), 'Grace');
	});

	it('clearing a value drops the entry rather than storing ""', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		store.setValue(NOTE, 'name', '');
		assert.equal(store.getValue(NOTE, 'name'), undefined);
		assert.deepEqual(store.serialize(), {});
	});

	it('returns an empty document for unknown notes', () => {
		const { store } = makeStore();
		assert.deepEqual(store.getValues('missing.md'), {});
		assert.deepEqual(store.getAnnotations('missing.md'), []);
	});
});

describe('annotations', () => {
	it('stores annotations per note', () => {
		const { store } = makeStore();
		store.setAnnotations(NOTE, [sampleAnnotation()]);
		assert.equal(store.getAnnotations(NOTE).length, 1);
		assert.equal(store.getAnnotations(NOTE)[0].meaning, 'a small feline');
	});

	it('removing the last annotation prunes the note entry', () => {
		const { store } = makeStore();
		store.setAnnotations(NOTE, [sampleAnnotation()]);
		store.setAnnotations(NOTE, []);
		assert.deepEqual(store.serialize(), {});
	});
});

describe('persistence round trip', () => {
	it('survives serialize and reload', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		store.setAnnotations(NOTE, [sampleAnnotation()]);

		// what would be written to data.json and read back next launch
		const written = JSON.parse(JSON.stringify(store.serialize())) as unknown;

		const { store: reloaded } = makeStore();
		reloaded.load(written);

		assert.equal(reloaded.getValue(NOTE, 'name'), 'Ada');
		assert.equal(reloaded.getAnnotations(NOTE)[0].text, 'cat');
		assert.equal(reloaded.getAnnotations(NOTE)[0].meaning, 'a small feline');
	});

	it('ignores absent or malformed stored data', () => {
		assert.deepEqual(parseDocuments(undefined), {});
		assert.deepEqual(parseDocuments('nonsense'), {});
		assert.deepEqual(parseDocuments({ 'a.md': 42 }), {});
		assert.deepEqual(parseDocuments({ 'a.md': { values: { k: 5 }, annotations: 'x' } }), {});
		assert.deepEqual(
			parseDocuments({ 'a.md': { values: { k: 'v' }, annotations: [{ bad: true }] } }),
			{ 'a.md': { values: { k: 'v' }, annotations: [] } },
		);
	});

	it('a fresh install with only settings in data.json loads cleanly', () => {
		const { store } = makeStore();
		store.load(undefined);
		assert.deepEqual(store.serialize(), {});
	});
});

describe('file lifecycle', () => {
	it('follows a renamed note', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		store.renameDocument(NOTE, 'notes/renamed.md');

		assert.equal(store.getValue('notes/renamed.md', 'name'), 'Ada');
		assert.equal(store.getValue(NOTE, 'name'), undefined);
	});

	it('renaming an unknown note does nothing', () => {
		const { store } = makeStore();
		store.renameDocument('missing.md', 'other.md');
		assert.deepEqual(store.serialize(), {});
	});

	it('forgets a deleted note', () => {
		const { store } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		store.deleteDocument(NOTE);
		assert.deepEqual(store.serialize(), {});
	});
});

describe('saving', () => {
	it('flush persists immediately', async () => {
		const { store, saves } = makeStore();
		store.setValue(NOTE, 'name', 'Ada');
		await store.flush();
		assert.equal(saves(), 1);
		store.destroy();
	});

	it('debounces rapid typing into a single write', async () => {
		const { store, saves } = makeStore();
		for (const value of ['A', 'Ad', 'Ada']) store.setValue(NOTE, 'name', value);
		assert.equal(saves(), 0);

		await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100));
		assert.equal(saves(), 1);
		store.destroy();
	});
});
