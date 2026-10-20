import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry } from './session-registry.js';

describe('daemon/session-registry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry({ staleMs: 2 * 60 * 60 * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a cwd active after ping', () => {
    registry.ping('s1', '/tmp/proj-a');
    expect(registry.isActive('/tmp/proj-a')).toBe(true);
  });

  it('is inactive for unknown cwd', () => {
    expect(registry.isActive('/tmp/never-seen')).toBe(false);
  });

  it('becomes inactive after SessionEnd leave', () => {
    registry.ping('s1', '/tmp/proj-a');
    registry.leave('s1');
    expect(registry.isActive('/tmp/proj-a')).toBe(false);
  });

  it('expires when no activity for longer than staleMs', () => {
    registry.ping('s1', '/tmp/proj-a');
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    expect(registry.isActive('/tmp/proj-a')).toBe(false);
  });

  it('ping refreshes lastSeen', () => {
    registry.ping('s1', '/tmp/proj-a');
    vi.advanceTimersByTime(60 * 60 * 1000);
    registry.ping('s1', '/tmp/proj-a');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(registry.isActive('/tmp/proj-a')).toBe(true);
  });

  it('two sessions in same cwd: leaving one keeps the other active', () => {
    registry.ping('s1', '/tmp/proj-a');
    registry.ping('s2', '/tmp/proj-a');
    registry.leave('s1');
    expect(registry.isActive('/tmp/proj-a')).toBe(true);
    registry.leave('s2');
    expect(registry.isActive('/tmp/proj-a')).toBe(false);
  });

  it('sessions for different cwd are independent', () => {
    registry.ping('s1', '/tmp/proj-a');
    registry.ping('s2', '/tmp/proj-b');
    registry.leave('s1');
    expect(registry.isActive('/tmp/proj-a')).toBe(false);
    expect(registry.isActive('/tmp/proj-b')).toBe(true);
  });

  it('treats a symlinked dir and its real path as the same cwd', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-real-'));
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-link-'));
    const linkPath = path.join(linkParent, 'alias');
    fs.symlinkSync(realDir, linkPath, 'dir');

    registry.ping('s1', linkPath);
    expect(registry.isActive(fs.realpathSync(realDir))).toBe(true);

    registry.leave('s1');
    expect(registry.isActive(fs.realpathSync(realDir))).toBe(false);

    registry.ping('s1', fs.realpathSync(realDir));
    expect(registry.isActive(linkPath)).toBe(true);

    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
  });
});
