import { describe, it, expect } from 'vitest';
import { encodeTerminalInput } from './injector.js';

const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';

describe('core/injector encodeTerminalInput', () => {
  it('wraps a short single-line message in bracketed paste and submits with CR', () => {
    const out = encodeTerminalInput('全部完成了吗');
    expect(out).toBe(`${PASTE_ON}全部完成了吗${PASTE_OFF}\r`);
  });

  it('normalizes CRLF/CR to LF inside the message', () => {
    const out = encodeTerminalInput('a\r\nb\rc');
    expect(out).toBe(`${PASTE_ON}a\nb\nc${PASTE_OFF}\r`);
  });

  it('keeps short multi-line messages in paste form', () => {
    const out = encodeTerminalInput('line1\nline2');
    expect(out).toBe(`${PASTE_ON}line1\nline2${PASTE_OFF}\r`);
  });

  it('avoids the paste placeholder for long messages by using literal text with Ctrl+J newlines', () => {
    const long = 'x'.repeat(600);
    const out = encodeTerminalInput(long);
    expect(out).not.toContain(PASTE_ON);
    expect(out.endsWith('\r')).toBe(true);
    expect(out.slice(0, out.length - 1)).toBe(long);
  });

  it('avoids the paste placeholder for many-line messages', () => {
    const many = Array.from({ length: 8 }, (_, i) => `line${i}`).join('\n');
    const out = encodeTerminalInput(many);
    expect(out).not.toContain(PASTE_ON);
    expect(out).toContain('\n');
    expect(out.endsWith('\r')).toBe(true);
  });

  it('strips control characters so user content cannot inject escape sequences', () => {
    const out = encodeTerminalInput('evil\x1b[31mred\x07bell');
    expect(out).toBe(`${PASTE_ON}evil[31mredbell${PASTE_OFF}\r`);
  });
});