import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Switch } from './switch.js';

describe('core/switch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-switch-test-'));
    process.env.DTMCP_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DTMCP_HOME;
  });

  describe('read/write', () => {
    it('defaults to enabled when no state file', async () => {
      const sw = new Switch();
      expect(await sw.get()).toBe(true);
    });

    it('persists enabled state', async () => {
      const sw = new Switch();
      await sw.set(false);

      const sw2 = new Switch();
      expect(await sw2.get()).toBe(false);
    });

    it('can toggle back to enabled', async () => {
      const sw = new Switch();
      await sw.set(false);
      await sw.set(true);

      const sw2 = new Switch();
      expect(await sw2.get()).toBe(true);
    });
  });
});
