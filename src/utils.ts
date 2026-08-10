import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { SyntaxNodeRef } from '@lezer/common';

const INLINE_MATH_BEGIN = "formatting-math-begin";
const MATH_END = "formatting-math-end";

export function nodeText(node: SyntaxNodeRef, state: EditorState): string {
    return state.sliceDoc(node.from, node.to);
}

/**
 * A "$" that is part of a display math "$$" is not an inline delimiter.
 * The Obsidian 1.13 parser can tokenize the two dollars of "$$" separately,
 * so the token text alone is not enough — the neighbors must be checked.
 */
function isLoneDollar(node: SyntaxNodeRef, state: EditorState): boolean {
    return nodeText(node, state) == "$"
        && state.sliceDoc(Math.max(0, node.from - 1), node.from) != "$"
        && state.sliceDoc(node.to, node.to + 1) != "$";
}

export function isInlineMathBegin(node: SyntaxNodeRef, state: EditorState): boolean {
    return node.name.includes(INLINE_MATH_BEGIN) && isLoneDollar(node, state)
}

export function isInlineMathEnd(node: SyntaxNodeRef, state: EditorState): boolean {
    return node.name.includes(MATH_END) && isLoneDollar(node, state)
}

export function selectionSatisfies(state: EditorState, predicate: (node: SyntaxNodeRef) => boolean): boolean {
    let ret = false;
    const tree = syntaxTree(state);
    for (const { from } of state.selection.ranges) {
        const line = state.doc.lineAt(from);
        tree.iterate({
            from: line.from,
            to: line.to,
            enter: node => {
                if (predicate(node)) {
                    ret = true;
                }
            },
        });
    }
    return ret;
}
