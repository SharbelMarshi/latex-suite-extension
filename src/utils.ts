import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { SyntaxNodeRef } from '@lezer/common';

const INLINE_MATH_BEGIN = "formatting-math-begin";
const MATH_END = "formatting-math-end";

export function nodeText(node: SyntaxNodeRef, state: EditorState): string {
    return state.sliceDoc(node.from, node.to);
}

export function isInlineMathBegin(node: SyntaxNodeRef, state: EditorState): boolean {
    return node.name.includes(INLINE_MATH_BEGIN) && nodeText(node, state) == "$"
}

export function isInlineMathEnd(node: SyntaxNodeRef, state: EditorState): boolean {
    return node.name.includes(MATH_END) && nodeText(node, state) == "$"
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
