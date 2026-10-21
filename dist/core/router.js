export function route(text, pendingQuestions) {
    const trimmed = text.trim();
    // Rule 1: Reserved command prefixes
    if (trimmed === '#开') {
        return { kind: 'command', cmd: 'enable' };
    }
    if (trimmed === '#关') {
        return { kind: 'command', cmd: 'disable' };
    }
    const cancelMatch = trimmed.match(/^#忽略(\d+)$/);
    if (cancelMatch) {
        return { kind: 'command', cmd: 'cancel', targetId: parseInt(cancelMatch[1], 10) };
    }
    // Rule 2: Explicit question ID
    const idMatch = trimmed.match(/^#Q(\d+):\s*(.+)$/s);
    if (idMatch) {
        const id = parseInt(idMatch[1], 10);
        const answerText = idMatch[2].trim();
        return { kind: 'answer', id, text: answerText };
    }
    // Rule 3: Single pending auto-assign
    if (pendingQuestions.length === 1) {
        const q = pendingQuestions[0];
        if (q.id !== undefined) {
            return { kind: 'answer', id: q.id, text: trimmed };
        }
    }
    // Rule 4: Multiple pending ambiguous
    if (pendingQuestions.length > 1) {
        return { kind: 'ambiguous' };
    }
    // No pending questions - treat as answer to nothing (shouldn't happen in practice)
    return { kind: 'ambiguous' };
}
//# sourceMappingURL=router.js.map