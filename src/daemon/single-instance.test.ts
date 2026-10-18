import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SingleInstance } from './single-instance.js';

describe('daemon/single-instance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-single-test-'));
    process.env.DTMCP_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DTMCP_HOME;
  });

  describe('tryAcquire()', () => {
    it('acquires lock when no other instance', async () => {
      const si = new SingleInstance('test-instance');
      const acquired = await si.tryAcquire();
      expect(acquired).toBe(true);
      await si.release();
    });

    it('fails to acquire when already held', async () => {
      const si1 = new SingleInstance('test-instance');
      await si1.tryAcquire();

      const si2 = new SingleInstance('test-instance');
      const acquired = await si2.tryAcquire();
      expect(acquired).toBe(false);

      await si1.release();
    });

    it('allows different instances', async () => {
      const si1 = new SingleInstance('instance-1');
      await si1.tryAcquire();

      const si2 = new SingleInstance('instance-2');
      const acquired = await si2.tryAcquire();
      expect(acquired).toBe(true);

      await si1.release();
      await si2.release();
    });
  });
});
