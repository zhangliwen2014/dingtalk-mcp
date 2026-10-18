import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from './mcp-server.js';
import { DaemonServer } from '../daemon/server.js';
import { FakeTransport } from '../transport/fake-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('McpServer', () => {
  let tempDir: string;
  let daemonServer: DaemonServer;
  let mcpServer: McpServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-mcp-test-'));
    const ipcEndpoint = path.join(tempDir, 'test.sock');

    const transport = new FakeTransport();
    transport.setResolveTargetResult('user123');
    const switchControl = new Switch(tempDir);
    const registry = new Registry(tempDir);

    daemonServer = new DaemonServer({
      transport,
      switch: switchControl,
      registry,
      ipcEndpoint,
    });
    await daemonServer.start();

    mcpServer = new McpServer(ipcEndpoint);
    await mcpServer.start();
  });

  afterEach(async () => {
    await mcpServer.stop();
    await daemonServer.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('can be instantiated and started', () => {
    expect(mcpServer).toBeDefined();
    expect(mcpServer.getServer()).toBeDefined();
  });

  it('connects to daemon via IPC', async () => {
    const status = await daemonServer.rpc('status', {});
    expect(status).toMatchObject({
      ok: true,
      enabled: true,
    });
  });
});
