import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Registry } from './registry.js';

describe('core/registry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-registry-test-'));
    process.env.DTMCP_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DTMCP_HOME;
  });

  describe('ID allocation', () => {
    it('allocates sequential IDs starting from 1', () => {
      const registry = new Registry();
      const id1 = registry.allocateId();
      expect(id1).toBe(1);

      const id2 = registry.allocateId();
      expect(id2).toBe(2);
    });
  });

  describe('pending management', () => {
    it('tracks pending questions', () => {
      const registry = new Registry();
      const id = registry.allocateId();
      registry.add({ id, text: 'test', target: 'user1' });

      const pending = registry.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(id);
    });

    it('removes answered questions from pending', () => {
      const registry = new Registry();
      const id = registry.allocateId();
      const q = registry.add({ id, text: 'test', target: 'user1' });

      q.accept('answer', 'phone');

      const pending = registry.listPending();
      expect(pending).toHaveLength(0);
    });

    it('retrieves question by ID', () => {
      const registry = new Registry();
      const id = registry.allocateId();
      registry.add({ id, text: 'test', target: 'user1' });

      const retrieved = registry.get(id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(id);
    });
  });

  describe('persistence', () => {
    it('persists state to disk', () => {
      const registry = new Registry();
      const id = registry.allocateId();
      registry.add({ id, text: 'test', target: 'user1' });
      registry.save();

      const registry2 = new Registry();
      registry2.load();
      const pending = registry2.listPending();
      expect(pending).toHaveLength(1);
    });

    it('restores next ID after reload', () => {
      const registry = new Registry();
      registry.allocateId();
      registry.allocateId();
      registry.save();

      const registry2 = new Registry();
      registry2.load();
      const nextId = registry2.allocateId();
      expect(nextId).toBe(3);
    });
  });
});
