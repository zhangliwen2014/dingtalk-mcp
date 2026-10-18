import { describe, it, expect } from 'vitest';
import * as ipc from './ipc.js';

describe('platform/ipc', () => {
  describe('endpoint format', () => {
    it('returns a valid endpoint string', () => {
      const endpoint = ipc.endpoint('test-instance');
      expect(endpoint).toBeDefined();
      expect(endpoint.length).toBeGreaterThan(0);
    });

    it('includes instance ID', () => {
      const endpoint = ipc.endpoint('my-instance');
      expect(endpoint).toContain('my-instance');
    });
  });
});
