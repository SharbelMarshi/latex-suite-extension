/**
 * Per-note storage for form field values and word meanings.
 *
 * Storage format: both live in the plugin's existing `data.json`, under a
 * `documents` map keyed by vault-relative file path, next to the settings that
 * were already there. Nothing is written into the note itself.
 *
 * Why out of band (see README for the full rationale): writing values or
 * meanings into the note would mean rewriting the user's prose on every
 * keystroke and emitting non-standard commands into exported LaTeX. The cost is
 * that data is keyed by path, so it is followed on rename (the plugin hooks the
 * vault's rename event) but does not travel with the file to another vault.
 */

import { Annotation, normalizeAnnotation } from './annotations-core';

export interface DocumentData {
	/** form field id -> entered value */
	values: Record<string, string>;
	annotations: Annotation[];
}

export type DocumentMap = Record<string, DocumentData>;

/** How long typing settles before the store writes to disk. */
export const SAVE_DEBOUNCE_MS = 400;

function emptyDocument(): DocumentData {
	return { values: {}, annotations: [] };
}

function isEmpty(doc: DocumentData): boolean {
	return Object.keys(doc.values).length === 0 && doc.annotations.length === 0;
}

/** Rebuild the documents map from whatever was in data.json. */
export function parseDocuments(raw: unknown): DocumentMap {
	const documents: DocumentMap = {};
	if (typeof raw !== 'object' || raw === null) return documents;

	for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== 'object' || value === null) continue;
		const entry = value as { values?: unknown; annotations?: unknown };
		const doc = emptyDocument();

		if (typeof entry.values === 'object' && entry.values !== null) {
			for (const [id, v] of Object.entries(entry.values as Record<string, unknown>)) {
				if (typeof v === 'string') doc.values[id] = v;
			}
		}
		if (Array.isArray(entry.annotations)) {
			for (const a of entry.annotations) {
				const annotation = normalizeAnnotation(a);
				if (annotation) doc.annotations.push(annotation);
			}
		}

		if (!isEmpty(doc)) documents[path] = doc;
	}

	return documents;
}

export class DocumentStore {
	private documents: DocumentMap = {};
	private saveTimeout: number | null = null;

	/** @param persist writes the whole plugin data file (settings + documents) */
	constructor(private readonly persist: () => Promise<void> | void) { }

	load(raw: unknown): void {
		this.documents = parseDocuments(raw);
	}

	serialize(): DocumentMap {
		return this.documents;
	}

	getDocument(path: string): DocumentData {
		return this.documents[path] ?? emptyDocument();
	}

	private mutate(path: string, fn: (doc: DocumentData) => void): void {
		const doc = this.documents[path] ?? emptyDocument();
		fn(doc);
		if (isEmpty(doc)) delete this.documents[path];
		else this.documents[path] = doc;
		this.scheduleSave();
	}

	/* ---- form field values ---- */

	getValues(path: string): Record<string, string> {
		return this.getDocument(path).values;
	}

	getValue(path: string, id: string): string | undefined {
		return this.getDocument(path).values[id];
	}

	setValue(path: string, id: string, value: string): void {
		this.mutate(path, doc => {
			if (value === '') delete doc.values[id];
			else doc.values[id] = value;
		});
	}

	clearValues(path: string): void {
		this.mutate(path, doc => { doc.values = {}; });
	}

	/* ---- annotations ---- */

	getAnnotations(path: string): Annotation[] {
		return this.getDocument(path).annotations;
	}

	setAnnotations(path: string, annotations: Annotation[]): void {
		this.mutate(path, doc => { doc.annotations = annotations; });
	}

	/* ---- file lifecycle ---- */

	renameDocument(oldPath: string, newPath: string): void {
		const doc = this.documents[oldPath];
		if (!doc) return;
		delete this.documents[oldPath];
		this.documents[newPath] = doc;
		this.scheduleSave();
	}

	deleteDocument(path: string): void {
		if (!this.documents[path]) return;
		delete this.documents[path];
		this.scheduleSave();
	}

	/* ---- persistence ---- */

	scheduleSave(): void {
		if (this.saveTimeout !== null) window.clearTimeout(this.saveTimeout);
		this.saveTimeout = window.setTimeout(() => {
			this.saveTimeout = null;
			void this.persist();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Write immediately (used on unload and by tests). */
	async flush(): Promise<void> {
		if (this.saveTimeout !== null) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}
		await this.persist();
	}

	destroy(): void {
		if (this.saveTimeout !== null) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}
	}
}
