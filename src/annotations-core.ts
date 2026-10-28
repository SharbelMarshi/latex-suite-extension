/**
 * Pure model + anchoring logic for word meanings.
 *
 * Annotations are stored out of band (see `document-store.ts`), never written
 * into the note, so the source text stays exactly what the user typed and
 * LaTeX export is unaffected. The price of that choice is that an annotation
 * has to be *re-anchored* to the text on every render. That is what this
 * module does, and keeping it free of DOM/Obsidian imports makes it testable.
 *
 * Anchoring uses three signals, in order of trust:
 *   1. the annotated text itself (an annotation whose text is gone is orphaned,
 *      never re-attached to something else),
 *   2. the surrounding context captured when the annotation was created,
 *   3. the occurrence index at creation time, as a tie-breaker.
 */

/** `occurrence` value meaning "every occurrence in the document". */
export const ALL_OCCURRENCES = -1;

/** How much surrounding text is remembered on each side. */
export const CONTEXT_SIZE = 24;

export interface Annotation {
	id: string;
	/** the exact text the meaning is attached to */
	text: string;
	meaning: string;
	/** optional example or note */
	note: string;
	/** occurrence index at creation time, or ALL_OCCURRENCES */
	occurrence: number;
	/** text immediately before/after the occurrence when it was created */
	before: string;
	after: string;
	createdAt: number;
}

export interface ResolvedAnnotation {
	annotation: Annotation;
	from: number;
	to: number;
}

/** Every non-overlapping occurrence of `text`, left to right. */
export function findOccurrences(source: string, text: string): number[] {
	const starts: number[] = [];
	if (!text) return starts;
	let from = 0;
	for (;;) {
		const index = source.indexOf(text, from);
		if (index === -1) break;
		starts.push(index);
		from = index + text.length;
	}
	return starts;
}

/** The context captured for an occurrence at `start`. */
export function contextFor(source: string, start: number, length: number): { before: string; after: string } {
	return {
		before: source.slice(Math.max(0, start - CONTEXT_SIZE), start),
		after: source.slice(start + length, start + length + CONTEXT_SIZE),
	};
}

function commonSuffixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function commonPrefixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/** How well the text around `start` matches the annotation's remembered context. */
export function contextScore(source: string, annotation: Annotation, start: number): number {
	const { before, after } = contextFor(source, start, annotation.text.length);
	return commonSuffixLength(before, annotation.before) + commonPrefixLength(after, annotation.after);
}

/** Smallest unused id, so ids stay short and deterministic. */
export function nextAnnotationId(annotations: Annotation[]): string {
	const used = new Set(annotations.map(a => a.id));
	for (let i = 1; ; i++) {
		const id = `m${i}`;
		if (!used.has(id)) return id;
	}
}

export interface CreateAnnotationInput {
	source: string;
	start: number;
	text: string;
	meaning: string;
	note?: string;
	applyAll?: boolean;
	id: string;
	createdAt?: number;
}

export function createAnnotation(input: CreateAnnotationInput): Annotation {
	const { source, start, text } = input;
	const occurrences = findOccurrences(source, text);
	const occurrence = input.applyAll ? ALL_OCCURRENCES : Math.max(0, occurrences.indexOf(start));
	const { before, after } = contextFor(source, start, text.length);

	return {
		id: input.id,
		text,
		meaning: input.meaning,
		note: input.note ?? '',
		occurrence,
		before,
		after,
		createdAt: input.createdAt ?? 0,
	};
}

/**
 * Where an annotation should be shown in the current source. Returns every
 * matching start offset (one entry normally, many for "apply to all"), or an
 * empty array when the annotated text no longer exists — an orphan is kept in
 * storage but never re-attached to unrelated text.
 */
export function resolveAnnotation(source: string, annotation: Annotation): number[] {
	const occurrences = findOccurrences(source, annotation.text);
	if (occurrences.length === 0) return [];
	if (annotation.occurrence === ALL_OCCURRENCES) return occurrences;
	if (occurrences.length === 1) return occurrences;    // still unique: surroundings may have changed

	let best = -1;
	let bestScore = -1;
	let bestDistance = Number.MAX_SAFE_INTEGER;

	for (let i = 0; i < occurrences.length; i++) {
		const score = contextScore(source, annotation, occurrences[i]);
		const distance = Math.abs(i - annotation.occurrence);
		if (score > bestScore || (score === bestScore && distance < bestDistance)) {
			best = occurrences[i];
			bestScore = score;
			bestDistance = distance;
		}
	}

	// No context survived anywhere: fall back to the remembered index if it
	// still exists, rather than guessing between identical candidates.
	if (bestScore === 0) {
		const byIndex = occurrences[annotation.occurrence];
		return byIndex === undefined ? [] : [byIndex];
	}

	return best === -1 ? [] : [best];
}

/**
 * Resolve every annotation against the source, dropping overlaps so no piece of
 * text is decorated twice. Earlier-created annotations win an overlap.
 */
export function resolveAnnotations(source: string, annotations: Annotation[]): ResolvedAnnotation[] {
	const ordered = [...annotations].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const resolved: ResolvedAnnotation[] = [];

	for (const annotation of ordered) {
		for (const start of resolveAnnotation(source, annotation)) {
			const from = start;
			const to = start + annotation.text.length;
			if (resolved.some(r => from < r.to && to > r.from)) continue;
			resolved.push({ annotation, from, to });
		}
	}

	return resolved.sort((a, b) => a.from - b.from);
}

/** The resolved annotation covering `offset`, if any. */
export function annotationAtOffset(resolved: ResolvedAnnotation[], offset: number): ResolvedAnnotation | null {
	return resolved.find(r => offset >= r.from && offset <= r.to) ?? null;
}

/** The resolved annotation overlapping a range, if any. */
export function annotationInRange(resolved: ResolvedAnnotation[], from: number, to: number): ResolvedAnnotation | null {
	return resolved.find(r => from <= r.to && to >= r.from) ?? null;
}

/** Add or replace an annotation, keyed by id. */
export function upsertAnnotation(annotations: Annotation[], annotation: Annotation): Annotation[] {
	const index = annotations.findIndex(a => a.id === annotation.id);
	if (index === -1) return [...annotations, annotation];
	const next = [...annotations];
	next[index] = annotation;
	return next;
}

export function removeAnnotation(annotations: Annotation[], id: string): Annotation[] {
	return annotations.filter(a => a.id !== id);
}

/** Annotations whose text is no longer present in the source. */
export function orphanedAnnotations(source: string, annotations: Annotation[]): Annotation[] {
	return annotations.filter(a => findOccurrences(source, a.text).length === 0);
}

/** Drop fields that are not part of the stored shape (defensive load). */
export function normalizeAnnotation(value: unknown): Annotation | null {
	if (typeof value !== 'object' || value === null) return null;
	const v = value as Partial<Annotation>;
	if (typeof v.id !== 'string' || typeof v.text !== 'string' || v.text === '') return null;
	return {
		id: v.id,
		text: v.text,
		meaning: typeof v.meaning === 'string' ? v.meaning : '',
		note: typeof v.note === 'string' ? v.note : '',
		occurrence: typeof v.occurrence === 'number' ? v.occurrence : 0,
		before: typeof v.before === 'string' ? v.before : '',
		after: typeof v.after === 'string' ? v.after : '',
		createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
	};
}
