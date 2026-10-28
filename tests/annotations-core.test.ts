import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ALL_OCCURRENCES,
	Annotation,
	annotationAtOffset,
	annotationInRange,
	createAnnotation,
	findOccurrences,
	nextAnnotationId,
	normalizeAnnotation,
	orphanedAnnotations,
	removeAnnotation,
	resolveAnnotation,
	resolveAnnotations,
	upsertAnnotation,
} from '../src/annotations-core';

/** Annotate the nth occurrence of `text` in `source`. */
function annotate(
	source: string,
	text: string,
	occurrence = 0,
	extra: Partial<Pick<Annotation, 'meaning' | 'note'>> & { applyAll?: boolean; id?: string } = {},
): Annotation {
	const start = findOccurrences(source, text)[occurrence];
	return createAnnotation({
		source,
		start,
		text,
		meaning: extra.meaning ?? 'a meaning',
		note: extra.note,
		applyAll: extra.applyAll,
		id: extra.id ?? 'm1',
	});
}

describe('finding occurrences', () => {
	it('finds every occurrence left to right', () => {
		assert.deepEqual(findOccurrences('cat dog cat', 'cat'), [0, 8]);
	});

	it('does not overlap matches', () => {
		assert.deepEqual(findOccurrences('aaaa', 'aa'), [0, 2]);
	});

	it('returns nothing for empty or absent text', () => {
		assert.deepEqual(findOccurrences('abc', ''), []);
		assert.deepEqual(findOccurrences('abc', 'z'), []);
	});
});

describe('creating annotations', () => {
	it('records the occurrence index and surrounding context', () => {
		const source = 'the cat sat, then the cat ran';
		const annotation = annotate(source, 'cat', 1);
		assert.equal(annotation.occurrence, 1);
		assert.ok(annotation.before.endsWith('then the '));
		assert.ok(annotation.after.startsWith(' ran'));
	});

	it('marks apply-to-all annotations', () => {
		const annotation = annotate('cat cat', 'cat', 0, { applyAll: true });
		assert.equal(annotation.occurrence, ALL_OCCURRENCES);
	});

	it('allocates the smallest unused id', () => {
		assert.equal(nextAnnotationId([]), 'm1');
		assert.equal(nextAnnotationId([annotate('cat', 'cat', 0, { id: 'm1' })]), 'm2');
	});
});

describe('resolving annotations to the source', () => {
	it('resolves a unique occurrence', () => {
		const source = 'a photon carries energy';
		assert.deepEqual(resolveAnnotation(source, annotate(source, 'photon')), [2]);
	});

	it('keeps duplicate words on their own occurrence', () => {
		const source = 'the cat sat, then the cat ran';
		const first = annotate(source, 'cat', 0, { id: 'm1' });
		const second = annotate(source, 'cat', 1, { id: 'm2' });

		assert.deepEqual(resolveAnnotation(source, first), [4]);
		assert.deepEqual(resolveAnnotation(source, second), [22]);
	});

	it('follows its occurrence when text is inserted before it', () => {
		const source = 'the cat sat, then the cat ran';
		const second = annotate(source, 'cat', 1, { id: 'm2' });

		const edited = 'PREFIX. ' + source;
		assert.deepEqual(resolveAnnotation(edited, second), [8 + 22]);
	});

	it('stays put when a new identical word appears before it', () => {
		const source = 'the cat sat';
		const annotation = annotate(source, 'cat');

		// a *new* first occurrence is inserted; the annotated one is now index 1
		const edited = 'a cat here. the cat sat';
		assert.deepEqual(resolveAnnotation(edited, annotation), [16]);
	});

	it('resolves every occurrence when applied to all', () => {
		const source = 'cat and cat and cat';
		const annotation = annotate(source, 'cat', 0, { applyAll: true });
		assert.deepEqual(resolveAnnotation(source, annotation), [0, 8, 16]);
	});

	it('orphans an annotation whose text is gone', () => {
		const source = 'the cat sat';
		const annotation = annotate(source, 'cat');
		assert.deepEqual(resolveAnnotation('nothing here', annotation), []);
	});

	it('still resolves when the surroundings changed but the word is unique', () => {
		const source = 'the cat sat on the mat';
		const annotation = annotate(source, 'cat');
		assert.deepEqual(resolveAnnotation('a cat!', annotation), [2]);
	});

	it('falls back to the remembered index when all context is gone', () => {
		const source = 'aaa cat bbb cat ccc';
		const annotation = annotate(source, 'cat', 1);
		// both candidates rewritten so no remembered context matches either;
		// the occurrence index is the only signal left
		assert.deepEqual(resolveAnnotation('XcatYcatZ', annotation), [5]);
	});

	it('prefers the better context match over the remembered index', () => {
		const source = 'aaa cat bbb cat ccc';
		const annotation = annotate(source, 'cat', 1);
		// the annotated occurrence moved to index 0 but kept its surroundings
		assert.deepEqual(resolveAnnotation('bbb cat ccc ... cat zzz', annotation), [4]);
	});

	it('reports orphans', () => {
		const source = 'the cat sat';
		const annotation = annotate(source, 'cat');
		assert.deepEqual(orphanedAnnotations('no felines', [annotation]).map(a => a.id), ['m1']);
		assert.deepEqual(orphanedAnnotations(source, [annotation]), []);
	});
});

describe('resolving a whole document', () => {
	it('returns ranges sorted by position', () => {
		const source = 'alpha beta gamma';
		const a = annotate(source, 'gamma', 0, { id: 'm1' });
		const b = annotate(source, 'alpha', 0, { id: 'm2' });

		const resolved = resolveAnnotations(source, [a, b]);
		assert.deepEqual(resolved.map(r => [r.annotation.id, r.from, r.to]), [
			['m2', 0, 5],
			['m1', 11, 16],
		]);
	});

	it('drops overlapping ranges, keeping the older annotation', () => {
		const source = 'quantum mechanics';
		const older: Annotation = { ...annotate(source, 'quantum mechanics', 0, { id: 'm1' }), createdAt: 1 };
		const newer: Annotation = { ...annotate(source, 'mechanics', 0, { id: 'm2' }), createdAt: 2 };

		const resolved = resolveAnnotations(source, [newer, older]);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0].annotation.id, 'm1');
	});

	it('locates the annotation under a cursor or selection', () => {
		const source = 'the cat sat';
		const resolved = resolveAnnotations(source, [annotate(source, 'cat')]);

		assert.equal(annotationAtOffset(resolved, 5)?.annotation.id, 'm1');
		assert.equal(annotationAtOffset(resolved, 0), null);
		assert.equal(annotationInRange(resolved, 0, 6)?.annotation.id, 'm1');
		assert.equal(annotationInRange(resolved, 8, 11), null);
	});
});

describe('editing and deleting', () => {
	it('replaces an annotation by id', () => {
		const source = 'the cat sat';
		const annotation = annotate(source, 'cat');
		const edited = { ...annotation, meaning: 'a small feline', note: 'purrs' };

		const list = upsertAnnotation([annotation], edited);
		assert.equal(list.length, 1);
		assert.equal(list[0].meaning, 'a small feline');
		assert.equal(list[0].note, 'purrs');
	});

	it('appends an annotation with a new id', () => {
		const source = 'the cat sat on the mat';
		const list = upsertAnnotation(
			[annotate(source, 'cat', 0, { id: 'm1' })],
			annotate(source, 'mat', 0, { id: 'm2' }),
		);
		assert.deepEqual(list.map(a => a.id), ['m1', 'm2']);
	});

	it('switching to apply-to-all decorates every occurrence', () => {
		const source = 'cat and cat';
		const annotation = annotate(source, 'cat', 0);
		const all = { ...annotation, occurrence: ALL_OCCURRENCES };
		assert.deepEqual(resolveAnnotation(source, all), [0, 8]);
	});

	it('removes an annotation by id', () => {
		const source = 'the cat sat';
		const list = [annotate(source, 'cat', 0, { id: 'm1' }), annotate(source, 'sat', 0, { id: 'm2' })];
		assert.deepEqual(removeAnnotation(list, 'm1').map(a => a.id), ['m2']);
		assert.deepEqual(removeAnnotation(list, 'nope').map(a => a.id), ['m1', 'm2']);
	});
});

describe('loading stored annotations', () => {
	it('fills in missing optional fields', () => {
		const annotation = normalizeAnnotation({ id: 'm1', text: 'cat' });
		assert.equal(annotation?.meaning, '');
		assert.equal(annotation?.note, '');
		assert.equal(annotation?.occurrence, 0);
	});

	it('rejects malformed entries', () => {
		assert.equal(normalizeAnnotation(null), null);
		assert.equal(normalizeAnnotation({ text: 'cat' }), null);
		assert.equal(normalizeAnnotation({ id: 'm1', text: '' }), null);
	});
});
