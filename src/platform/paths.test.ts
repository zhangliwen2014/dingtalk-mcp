import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as paths from './paths.js';

describe('platform/paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('home()', () => {
    it('returns DTMCP_HOME when set', () => {
      process.env.DTMCP_HOME = '/custom/path';
      expect(paths.home()).toBe('/custom/path');
    });

    it('returns platform default when DTMCP_HOME not set', () => {
      delete process.env.DTMCP_HOME;
      const home = paths.home();
      expect(home).toBeDefined();
      expect(home.length).toBeGreaterThan(0);
    });
  });

  describe('state()', () => {
    it('returns state.json path under home', () => {
      process.env.DTMCP_HOME = '/test/home';
      const statePath = paths.state();
      expect(statePath).toContain('state.json');
      expect(statePath.startsWith('/test/home')).toBe(true);
    });
  });

  describe('log()', () => {
    it('returns daemon.log path under home', () => {
      process.env.DTMCP_HOME = '/test/home';
      const logPath = paths.log();
      expect(logPath).toContain('daemon.log');
      expect(logPath.startsWith('/test/home')).toBe(true);
    });
  });

  describe('ipcEndpoint()', () => {
    it('returns socket path on POSIX', () => {
      process.env.DTMCP_HOME = '/test/home';
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      
      const endpoint = paths.ipcEndpoint();
      expect(endpoint).toContain('dtmcp.sock');
      
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });
});
