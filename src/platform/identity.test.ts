import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as identity from './identity.js';

describe('platform/identity', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('instanceId()', () => {
    it('returns a non-empty string', () => {
      const id = identity.instanceId();
      expect(id).toBeDefined();
      expect(id.length).toBeGreaterThan(0);
    });

    it('includes OS username', () => {
      const id = identity.instanceId();
      const username = process.env.USER || process.env.USERNAME || 'unknown';
      expect(id).toContain(username);
    });

    it('is deterministic for same config', () => {
      process.env.DTMCP_HOME = '/same/path';
      const id1 = identity.instanceId();
      const id2 = identity.instanceId();
      expect(id1).toBe(id2);
    });

    it('differs for different config paths', () => {
      process.env.DTMCP_HOME = '/path/one';
      const id1 = identity.instanceId();
      
      process.env.DTMCP_HOME = '/path/two';
      const id2 = identity.instanceId();
      
      expect(id1).not.toBe(id2);
    });
  });
});
