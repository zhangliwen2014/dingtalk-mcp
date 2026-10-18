import { DaemonServer } from './server.js';
import { DwsTransport } from '../transport/dws-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { SingleInstance } from './single-instance.js';
import * as paths from '../platform/paths.js';
import * as ipc from '../platform/ipc.js';
import * as identity from '../platform/identity.js';

export class Daemon {
  private server: DaemonServer | null = null;
  private instance: SingleInstance | null = null;
  private transport: DwsTransport | null = null;

  async start(): Promise<void> {
    const instanceId = identity.instanceId();
    this.instance = new SingleInstance(instanceId);

    const acquired = await this.instance.tryAcquire();
    if (!acquired) {
      throw new Error('Another daemon instance is already running');
    }

    const configDir = paths.home();
    const ipcEndpoint = ipc.endpoint(instanceId);
    this.transport = new DwsTransport();
    const switchControl = new Switch(configDir);
    const registry = new Registry(configDir);
    registry.load();

    this.server = new DaemonServer({
      transport: this.transport,
      switch: switchControl,
      registry,
      ipcEndpoint,
    });

    await this.server.start();
    
    // Start polling for messages
    await this.transport.listen((message) => {
      this.server!.rpc('ingest', { text: message.text }).catch((err) => {
        console.error('Ingest error:', err);
      });
    });

    console.log(`Daemon started on ${ipcEndpoint}`);
    console.log(`Instance ID: ${instanceId}`);
    console.log(`Polling for messages every 3 seconds...`);
  }

  async stop(): Promise<void> {
    if (this.transport) {
      this.transport.stopListening();
      this.transport = null;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    if (this.instance) {
      await this.instance.release();
      this.instance = null;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new Daemon();
  daemon.start().catch((err) => {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
}
