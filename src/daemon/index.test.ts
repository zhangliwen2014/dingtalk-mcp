import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHeadlessEnabled, resolveAllowedSenderIds } from './index.js';

describe('daemon/index resolveHeadlessEnabled', () => {
  let tempDir: string;
  const originalEnv = process.env.DTMCP_AGENT_HEADLESS;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-headless-'));
    delete process.env.DTMCP_AGENT_HEADLESS;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.DTMCP_AGENT_HEADLESS;
    } else {
      process.env.DTMCP_AGENT_HEADLESS = originalEnv;
    }
  });

  it('defaults to false with no env and no config', () => {
    expect(resolveHeadlessEnabled(tempDir)).toBe(false);
  });

  it('reads agent.headless from config.json', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ agent: { headless: true } })
    );
    expect(resolveHeadlessEnabled(tempDir)).toBe(true);
  });

  it('env var overrides config.json', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ agent: { headless: true } })
    );
    process.env.DTMCP_AGENT_HEADLESS = '0';
    expect(resolveHeadlessEnabled(tempDir)).toBe(false);
  });

  it('env var enables regardless of config', () => {
    process.env.DTMCP_AGENT_HEADLESS = 'true';
    expect(resolveHeadlessEnabled(tempDir)).toBe(true);
  });
});

describe('daemon/index resolveAllowedSenderIds', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-senders-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when config or key is missing (open mode)', () => {
    expect(resolveAllowedSenderIds(tempDir)).toBeUndefined();

    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ agent: { headless: true } })
    );
    expect(resolveAllowedSenderIds(tempDir)).toBeUndefined();
  });

  it('reads security.allowedSenderIds from config.json', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ security: { allowedSenderIds: ['owner-1', 'owner-2'] } })
    );
    expect(resolveAllowedSenderIds(tempDir)).toEqual(['owner-1', 'owner-2']);
  });

  it('treats an empty array as open mode', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ security: { allowedSenderIds: [] } })
    );
    expect(resolveAllowedSenderIds(tempDir)).toBeUndefined();
  });
});
