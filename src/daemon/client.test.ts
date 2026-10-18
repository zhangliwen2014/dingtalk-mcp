import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IpcClient } from './client.js';
import { DaemonServer } from './server.js';
import { FakeTransport } from '../transport/fake-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('IpcClient', () => {
  let tempDir: string;
  let server: DaemonServer;
  let client: IpcClient;
  let ipcEndpoint: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-ipc-test-'));
    ipcEndpoint = path.join(tempDir, 'test.sock');

    const transport = new FakeTransport();
    const switchControl = new Switch(tempDir);
    const registry = new Registry(tempDir);

    server = new DaemonServer({
      transport,
      switch: switchControl,
      registry,
      ipcEndpoint,
    });
    await server.start();

    client = new IpcClient(ipcEndpoint);
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sends hello and receives version', async () => {
    const result = await client.request('hello', { version: '1.0.0' });
    expect(result).toMatchObject({
      ok: true,
      version: expect.any(String),
    });
  });

  it('sends ask and receives pending', async () => {
    const result = await client.request('status', {});
    expect(result).toMatchObject({
      ok: true,
      enabled: true,
    });
  });

  it('handles multiple sequential requests', async () => {
    const r1 = await client.request('hello', { version: '1.0.0' });
    const r2 = await client.request('status', {});
    const r3 = await client.request('hello', { version: '1.0.0' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
  });
});
