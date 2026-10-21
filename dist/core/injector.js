const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';
const PASTE_MAX_CHARS = 500;
const PASTE_MAX_LINES = 5;
function sanitize(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (ch === '\n' || ch === '\t') {
            out += ch;
        }
        else if (code < 0x20 || code === 0x7f) {
            // Drop other C0/DEL control characters so they cannot hijack the TUI input parser.
            continue;
        }
        else {
            out += ch;
        }
    }
    return out;
}
export function encodeTerminalInput(message) {
    const normalized = message.replace(/\r\n|\r/g, '\n');
    const text = sanitize(normalized);
    const lines = text.split('\n').length;
    const fitsPaste = text.length <= PASTE_MAX_CHARS && lines <= PASTE_MAX_LINES;
    if (fitsPaste) {
        return `${PASTE_ON}${text}${PASTE_OFF}\r`;
    }
    return `${text}\r`;
}
//# sourceMappingURL=injector.js.map